import { WebSocket, WebSocketServer } from 'ws'
import type { Server } from 'http'
import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import { sendMessage, resumeSession, resetSession, getWorkingDir, getActiveSessions, killSession, killAllSessions, attachWebSocket, revertFiles, saveImagesToTempFiles } from './agentPool.js'
import { processWithTools, generateTaskPrompts, type PlanCallbacks, type PromptGenCallbacks } from './gektoTools.js'
import type { ExecutionPlan, Task } from './types.js'
import { randomUUID } from 'crypto'
import { initGekto, getGektoState, abortGekto, setStateCallback, resetGektoSession, restoreGektoSession, getGektoSessionId } from './gektoPersistent.js'
import { getState, mutate, mutateBatch, addClient, removeClient, sendSnapshot, getClients, broadcastPlan, broadcastTask, broadcastAgent, broadcastVisuals, broadcastVisualDelete, broadcastForPath, type Agent, type Message } from '../state.js'
import { persistEntity } from '../entityStore.js'

let gektoInitialized = false

function broadcastGektoState(state: 'loading' | 'ready' | 'error') {
  const message = JSON.stringify({ type: 'gekto_state', state })
  for (const client of getClients()) {
    if (client.readyState === 1) {
      client.send(message)
    }
  }
}

// Log outgoing WS message (skip noisy streaming deltas)
function logOutgoing(msg: Record<string, unknown>) {
  const type = msg.type as string
  if (type === 'gekto_text' || type === 'gekto_thinking') return // too noisy
  const lizardId = msg.lizardId as string | undefined
  const extra = [
    msg.tool ? `tool=${msg.tool}` : '',
    msg.state ? `state=${msg.state}` : '',
    msg.planId ? `plan=${msg.planId}` : '',
  ].filter(Boolean).join(' ')
  console.log(`[WS→] ${type}${lizardId ? ` [${lizardId}]` : ''}${extra ? ' ' + extra : ''}`)
}

// Summarize tool input for display
function summarizeToolInput(input?: Record<string, unknown>): string {
  if (!input) return ''
  if (input.file_path) return String(input.file_path)
  if (input.pattern) return String(input.pattern)
  if (input.command) return String(input.command).substring(0, 50)
  if (input.path) return String(input.path)
  if (input.query) return String(input.query).substring(0, 50)
  return ''
}

export function setupAgentWebSocket(server: Server, path: string = '/__gekto/agent') {
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = request.url || ''

    if (url === path || url.startsWith(path + '?')) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request)
      })
    }
  })

  wss.on('connection', (ws: WebSocket) => {
    // Wrap ws.send for logging
    const originalSend = ws.send.bind(ws)
    const loggedSend: typeof ws.send = (data, ...args) => {
      if (typeof data === 'string') {
        try { logOutgoing(JSON.parse(data)) } catch { /* ignore */ }
      }
      return originalSend(data, ...args)
    }
    ws.send = loggedSend

    // Track client for state diffs
    addClient(ws)

    // Always ensure Gekto is initialized and callback is set
    setStateCallback(broadcastGektoState)
    if (!gektoInitialized) {
      // Restore previous Gekto session from current master agent
      const currentState = getState()
      const masterAgent = currentState.agents[currentState.currentMasterId]
      const historyMessages = masterAgent?.messages?.map(m => ({ text: m.text, sender: m.sender }))
      initGekto(getWorkingDir(), broadcastGektoState, masterAgent?.sessionId, historyMessages)
      gektoInitialized = true
    }

    // Attach this WebSocket to all existing sessions (for reconnection)
    attachWebSocket(ws)

    // Send full state snapshot on connect
    sendSnapshot(ws)

    // Send working directory info
    ws.send(JSON.stringify({ type: 'info', workingDir: getWorkingDir() }))

    // Send current Gekto state
    ws.send(JSON.stringify({ type: 'gekto_state', state: getGektoState() }))

    // Send current state for all active sessions
    const activeSessions = getActiveSessions()
    for (const session of activeSessions) {
      ws.send(JSON.stringify({
        type: 'state',
        lizardId: session.lizardId,
        state: session.state,
      }))
    }

    ws.on('message', async (message: Buffer | string) => {
      try {
        const msg = JSON.parse(message.toString())

        // Commands that don't require lizardId
        switch (msg.type) {
          case 'list_agents':
            ws.send(JSON.stringify({
              type: 'agents_list',
              agents: getActiveSessions(),
            }))
            return

          case 'debug_pool':
            const sessions = getActiveSessions()
            ws.send(JSON.stringify({
              type: 'debug_pool_result',
              sessions,
            }))
            return

          case 'kill_all': {
            const killedCount = killAllSessions()
            ws.send(JSON.stringify({
              type: 'kill_all_result',
              killed: killedCount,
            }))
            // Notify about state changes
            for (const session of getActiveSessions()) {
              ws.send(JSON.stringify({ type: 'state', lizardId: session.lizardId, state: 'ready' }))
            }
            return
          }

          case 'create_plan': {
            // Set master lizard to working state
            ws.send(JSON.stringify({ type: 'state', lizardId: 'master', state: 'working' }))

            // Save attached images to temp files
            const planImages = msg.images as string[] | undefined
            let planImagePaths: string[] | undefined
            if (planImages && planImages.length > 0) {
              planImagePaths = saveImagesToTempFiles(planImages)
            }

            try {
              // Server-side accumulators and block counter
              let accThinking = ''
              let accText = ''
              let blockIndex = 0

              // Streaming callbacks for tool events and text
              const planCallbacks: PlanCallbacks = {
                onToolStart: (tool, input) => {
                  accThinking = ''
                  accText = ''
                  blockIndex++
                  ws.send(JSON.stringify({
                    type: 'tool',
                    lizardId: 'master',
                    status: 'running',
                    tool,
                    input: summarizeToolInput(input),
                    fullInput: input,
                  }))
                },
                onToolEnd: (tool) => {
                  ws.send(JSON.stringify({
                    type: 'tool',
                    lizardId: 'master',
                    status: 'completed',
                    tool,
                  }))
                },
                onText: (text) => {
                  accText += text
                  console.log('onText', accText)
                  ws.send(JSON.stringify({
                    type: 'gekto_text',
                    planId: msg.planId,
                    text: accText,
                    blockIndex,
                  }))
                },
                onThinking: (text) => {
                  accThinking += text
                  ws.send(JSON.stringify({
                    type: 'gekto_thinking',
                    planId: msg.planId,
                    text: accThinking,
                    blockIndex,
                  }))
                },
              }

              // Signal client that planning has started
              ws.send(JSON.stringify({
                type: 'planning_started',
                planId: msg.planId,
                prompt: msg.prompt,
              }))

              const planResult = await processWithTools(
                msg.prompt,
                msg.planId,
                getWorkingDir(),
                getActiveSessions(),
                planCallbacks,
                msg.existingPlan,
                planImagePaths,
              )

              // Replace streamed JSON with clean message (always send to overwrite raw JSON)
              const cleanMessage = planResult.message || planResult.plan?.reasoning || 'Got it, here\'s the plan.'
              ws.send(JSON.stringify({
                type: 'gekto_text',
                planId: msg.planId,
                text: cleanMessage,
                blockIndex,
              }))

              if (planResult.type === 'build' && planResult.plan) {
                // Store tasks separately in server state
                const taskMutations: Array<{ path: string; value: unknown }> = []
                if (planResult.tasks) {
                  for (const task of planResult.tasks) {
                    taskMutations.push({ path: `tasks.${task.id}`, value: task })
                  }
                }
                // Store plan + tasks atomically
                mutateBatch([
                  { path: 'plan', value: planResult.plan },
                  ...taskMutations,
                ])
                broadcastPlan()
                if (planResult.tasks) {
                  for (const task of planResult.tasks) {
                    broadcastTask(task.id)
                  }
                }

                ws.send(JSON.stringify({
                  type: 'plan_created',
                  planId: msg.planId,
                  plan: planResult.plan,
                }))
              } else if (planResult.type === 'remove' && planResult.removedAgents) {
                // Remove agents from server state
                for (const agentId of planResult.removedAgents) {
                  mutate(`agents.${agentId}`, undefined)
                  broadcastAgent(agentId)
                }
                ws.send(JSON.stringify({
                  type: 'gekto_remove',
                  planId: msg.planId,
                  agents: planResult.removedAgents,
                }))
              } else if (planResult.type === 'chat') {
                // Chat reply — clear the temporary 'planning' plan state
                const currentState = getState()
                if (currentState.plan?.status === 'planning') {
                  mutate('plan', null)
                  broadcastPlan()
                }
              }
              // Persist Gekto session ID on current master so it survives restart
              const masterState = getState()
              if (masterState.agents[masterState.currentMasterId]) {
                mutate(`agents.${masterState.currentMasterId}.sessionId`, getGektoSessionId())
              }

              // Signal master finalize so client stops streaming animations
              ws.send(JSON.stringify({ type: 'gekto_done', planId: msg.planId }))
              ws.send(JSON.stringify({ type: 'state', lizardId: 'master', state: 'ready' }))
            } catch (err) {
              console.error('[Agent] Gekto processing failed:', err)
              ws.send(JSON.stringify({
                type: 'gekto_chat',
                planId: msg.planId,
                message: `Error: ${err instanceof Error ? err.message : 'Processing failed'}`,
              }))
              // Clear stale planning state on error
              const currentState = getState()
              if (currentState.plan?.status === 'planning') {
                mutate('plan', null)
                broadcastPlan()
              }
              
              ws.send(JSON.stringify({ type: 'gekto_done', planId: msg.planId }))
              ws.send(JSON.stringify({ type: 'state', lizardId: 'master', state: 'ready' }))
            }
            return
          }

          case 'generate_prompts': {
            const currentState = getState()
            const genPlan = currentState.plan
            if (!genPlan || genPlan.id !== msg.planId) {
              ws.send(JSON.stringify({ type: 'error', message: 'Plan not found' }))
              return
            }

            // Resolve tasks from state
            const planTasks = genPlan.taskIds
              .map(id => currentState.tasks[id])
              .filter((t): t is Task => !!t)

            // Set master to working while generating
            ws.send(JSON.stringify({ type: 'state', lizardId: 'master', state: 'working' }))

            try {
              const genCallbacks: PromptGenCallbacks = {
                onTaskPromptGenerated: (taskId, prompt) => {
                  // Update task prompt in server state
                  mutate(`tasks.${taskId}.prompt`, prompt)
                  broadcastTask(taskId)
                  // Notify client
                  ws.send(JSON.stringify({
                    type: 'prompt_generated',
                    planId: msg.planId,
                    taskId,
                    prompt,
                  }))
                },
                onAllPromptsReady: () => {
                  mutate('plan.status', 'prompts_ready')
                  broadcastPlan()
                  ws.send(JSON.stringify({
                    type: 'prompts_ready',
                    planId: msg.planId,
                  }))
                },
                onError: (taskId, error) => {
                  const state = getState()
                  const fallback = state.tasks[taskId]?.description || 'Execute task'
                  ws.send(JSON.stringify({
                    type: 'prompt_generated',
                    planId: msg.planId,
                    taskId,
                    prompt: fallback,
                    error,
                  }))
                },
              }

              await generateTaskPrompts(genPlan, planTasks, getWorkingDir(), genCallbacks)
            } catch (err) {
              console.error('[Agent] Prompt generation failed:', err)
              ws.send(JSON.stringify({
                type: 'gekto_chat',
                planId: msg.planId,
                message: `Error generating prompts: ${err instanceof Error ? err.message : 'Failed'}`,
              }))
            }

            ws.send(JSON.stringify({ type: 'state', lizardId: 'master', state: 'ready' }))
            return
          }

          case 'execute_plan': {
            // Update plan status in server state
            const currentState = getState()
            if (currentState.plan && currentState.plan.id === msg.planId) {
              mutate('plan.status', 'executing')
              broadcastPlan()
            }
            return
          }

          case 'cancel_plan': {
            const currentState = getState()
            if (currentState.plan && currentState.plan.id === msg.planId) {
              mutate('plan', null)
              broadcastPlan()
            }
            return
          }

          // Client creates task+agent in server state before sending chat
          case 'create_task_and_agent': {
            const { task, agent } = msg as { task: Task; agent: Agent }
            mutateBatch([
              { path: `tasks.${task.id}`, value: task },
              { path: `agents.${agent.id}`, value: agent },
            ])
            broadcastTask(task.id)
            broadcastAgent(agent.id)
            return
          }

          // Client updates a chat message list — store on agent
          case 'save_chat': {
            let { agentId } = msg as { agentId: string; messages: Message[] }
            const { messages } = msg as { agentId: string; messages: Message[] }
            const state = getState()

            // Resolve 'master' to the current master session ID
            if (agentId === 'master') {
              agentId = state.currentMasterId
            }

            if (state.agents[agentId]) {
              mutate(`agents.${agentId}.messages`, messages)
            } else {
              // Create agent record — messages persist via entity store
              mutate(`agents.${agentId}`, {
                id: agentId,
                taskId: '',
                personaId: 'plain',
                status: 'idle',
                messages,
                createdAt: new Date().toISOString(),
              })
            }
            broadcastAgent(agentId)
            return
          }

          // Generic state mutation from client
          case 'save_state': {
            const { path: statePath, value: stateValue } = msg as { path: string; value: unknown }
            if (statePath) {
              mutate(statePath, stateValue)
              broadcastForPath(statePath)
            }
            return
          }

          // Client saves visual positions
          case 'save_visuals': {
            const { visuals } = msg as { visuals: Record<string, { position: { x: number; y: number }; color: string }> }
            mutate('visuals', visuals)
            broadcastVisuals()
            return
          }

          // Task completion reported by client
          case 'task_completed': {
            if (msg.taskId) {
              const mutations: Array<{ path: string; value: unknown }> = [
                { path: `tasks.${msg.taskId}.status`, value: 'pending_testing' },
              ]
              if (msg.result) {
                mutations.push({ path: `tasks.${msg.taskId}.result`, value: msg.result })
              }
              mutateBatch(mutations)
              broadcastTask(msg.taskId)
            }
            return
          }

          case 'task_failed': {
            if (msg.taskId) {
              mutateBatch([
                { path: `tasks.${msg.taskId}.status`, value: 'failed' },
                { path: `tasks.${msg.taskId}.error`, value: msg.error },
              ])
              broadcastTask(msg.taskId)
            }
            return
          }

          case 'task_started': {
            if (msg.taskId) {
              mutateBatch([
                { path: `tasks.${msg.taskId}.status`, value: 'in_progress' },
                { path: `tasks.${msg.taskId}.assignedAgentId`, value: msg.lizardId },
              ])
              broadcastTask(msg.taskId)
            }
            return
          }

          // Update agent status in server state
          case 'update_agent': {
            const { agentId, updates } = msg as { agentId: string; updates: Partial<Agent> }
            const state = getState()
            if (state.agents[agentId]) {
              for (const [key, value] of Object.entries(updates)) {
                mutate(`agents.${agentId}.${key}`, value)
              }
              broadcastAgent(agentId)
            }
            return
          }

          // Soft-delete agent: persist 'done' status to disk, then remove from in-memory state
          case 'delete_agent': {
            const state = getState()
            const agent = state.agents[msg.agentId]
            if (agent) {
              // Write final state to disk with 'done' status (keeps history on disk)
              persistEntity('agents', msg.agentId, {
                ...agent,
                status: 'done',
                completedAt: new Date().toISOString(),
              })
            }
            // Remove from in-memory state so client never sees it
            mutate(`agents.${msg.agentId}`, undefined)
            mutate(`visuals.${msg.agentId}`, undefined)
            broadcastAgent(msg.agentId)
            broadcastVisualDelete(msg.agentId)
            return
          }

          // Mark task resolved — remove from plan
          case 'mark_task_resolved': {
            const state = getState()
            if (state.plan) {
              const remainingTaskIds = state.plan.taskIds.filter(id => id !== msg.taskId)
              const allDone = remainingTaskIds.length === 0
              mutateBatch([
                { path: 'plan.taskIds', value: remainingTaskIds },
                ...(allDone ? [
                  { path: 'plan.status', value: 'completed' },
                  { path: 'plan.completedAt', value: new Date().toISOString() },
                ] : []),
              ])
              broadcastPlan()
            }
            // Mark task as completed
            if (msg.taskId) {
              mutate(`tasks.${msg.taskId}.status`, 'completed')
              broadcastTask(msg.taskId)
            }
            // Remove linked agent
            if (msg.agentId) {
              mutate(`agents.${msg.agentId}`, undefined)
              mutate(`visuals.${msg.agentId}`, undefined)
              broadcastAgent(msg.agentId)
              broadcastVisualDelete(msg.agentId)
            }
            return
          }

          case 'archive_gekto_session': {
            const { messages: archiveMessages } = msg as {
              messages: Message[]
              plan?: unknown
            }
            const currentState = getState()
            const oldMasterId = currentState.currentMasterId
            const archiveSessionId = getGektoSessionId()

            // Mark current master as archived
            if (currentState.agents[oldMasterId]) {
              mutateBatch([
                { path: `agents.${oldMasterId}.status`, value: 'done' },
                { path: `agents.${oldMasterId}.completedAt`, value: new Date().toISOString() },
                { path: `agents.${oldMasterId}.sessionId`, value: archiveSessionId },
              ])
            } else {
              // Current master had no agent record — persist the archived messages
              mutate(`agents.${oldMasterId}`, {
                id: oldMasterId,
                taskId: '',
                personaId: 'plain',
                status: 'done',
                messages: archiveMessages,
                sessionId: archiveSessionId,
                createdAt: new Date().toISOString(),
                completedAt: new Date().toISOString(),
              })
            }

            // Create new master session
            const newMasterId = `master_${Date.now()}`
            mutate('currentMasterId', newMasterId)

            // Broadcast so client picks up the new ID
            for (const client of getClients()) {
              if (client.readyState === 1) {
                client.send(JSON.stringify({
                  type: 'current_master_changed',
                  currentMasterId: newMasterId,
                }))
              }
            }
            return
          }

          case 'restore_gekto_session': {
            const { sessionId: restoreId } = msg as { sessionId: string }
            const currentState = getState()

            // Look for the agent in memory or on disk (archived agents have status 'done' and aren't loaded)
            let agentSession = currentState.agents[restoreId]
            if (!agentSession) {
              // Try loading from disk (archived agents with status 'done' aren't in memory)
              try {
                const fs = await import('fs')
                const path = await import('path')
                const filePath = path.join(process.cwd(), '.gekto', 'agents', `${restoreId}.json`)
                if (fs.existsSync(filePath)) {
                  agentSession = JSON.parse(fs.readFileSync(filePath, 'utf8'))
                }
              } catch { /* ignore */ }
            }

            if (agentSession?.messages) {
              // Switch current master to the restored session
              mutate(`agents.${restoreId}`, { ...agentSession, status: 'idle' })
              mutate('currentMasterId', restoreId)
              broadcastAgent(restoreId)

              if (agentSession.sessionId) {
                restoreGektoSession(agentSession.sessionId)
              }

              for (const client of getClients()) {
                if (client.readyState === 1) {
                  client.send(JSON.stringify({
                    type: 'current_master_changed',
                    currentMasterId: restoreId,
                  }))
                }
              }

              ws.send(JSON.stringify({
                type: 'session_restored',
                sessionId: restoreId,
                plan: null,
              }))
            } else {
              ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }))
            }
            return
          }

          case 'resume_agent': {
            const { lizardId: resumeId, sessionId: resumeSessionId, prompt: resumePrompt } = msg
            if (!resumeId) {
              ws.send(JSON.stringify({ type: 'error', message: 'Missing lizardId for resume' }))
              return
            }
            // Create session with restored sessionId
            resumeSession(resumeId, resumeSessionId, ws)
            // Send the original prompt to resume work
            try {
              await sendMessage(resumeId, resumePrompt || 'Continue where you left off.', ws)
            } catch (err) {
              console.error(`[Agent] Resume failed for ${resumeId}:`, err)
            }
            return
          }
        }

        // Commands that require lizardId
        const lizardId = msg.lizardId
        if (!lizardId) {
          ws.send(JSON.stringify({ type: 'error', message: 'Missing lizardId' }))
          return
        }

        switch (msg.type) {
          case 'chat':
            try {
              // Update agent status in state
              const state = getState()
              if (state.agents[lizardId]) {
                mutate(`agents.${lizardId}.status`, 'working')
                broadcastAgent(lizardId)
              }
              const images = (msg.images as string[] | undefined)
              await sendMessage(lizardId, msg.content, ws, images)
            } catch (err) {
              console.error(`[Agent] [${lizardId}] Error:`, err)
            }
            break

          case 'reset':
            if (lizardId === 'master') {
              resetGektoSession()
            } else {
              resetSession(lizardId)
            }
            ws.send(JSON.stringify({ type: 'state', lizardId, state: 'ready' }))
            break

          case 'revert_files': {
            const revertResult = revertFiles(msg.filePaths || [], msg.fileChanges || [])
            ws.send(JSON.stringify({
              type: 'files_reverted',
              lizardId,
              reverted: revertResult.reverted,
              failed: revertResult.failed,
            }))
            // Remove reverted file changes from server state
            const agentState = getState().agents[lizardId]
            if (agentState?.fileChanges) {
              const revertedSet = new Set(revertResult.reverted)
              const remaining = agentState.fileChanges.filter(fc => !revertedSet.has(fc.filePath))
              mutate(`agents.${lizardId}.fileChanges`, remaining)
              broadcastAgent(lizardId)
            }
            break
          }

          case 'kill': {
            // For master, abort the persistent Gekto process instead of killing session
            const killed = lizardId === 'master' ? abortGekto() : killSession(lizardId)
            ws.send(JSON.stringify({
              type: 'kill_result',
              lizardId,
              killed,
            }))
            ws.send(JSON.stringify({ type: 'state', lizardId, state: 'ready' }))
            break
          }
        }
      } catch (err) {
        console.error('[Agent] Failed to parse message:', err)
      }
    })

    ws.on('close', () => {
      removeClient(ws)
    })

    ws.on('error', (err) => {
      console.error('[Agent] WebSocket error:', err)
    })
  })

  return wss
}
