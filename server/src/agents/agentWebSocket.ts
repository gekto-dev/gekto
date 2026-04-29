import { WebSocket, WebSocketServer } from 'ws'
import type { Server } from 'http'
import type { IncomingMessage } from 'http'
import type { Duplex } from 'stream'
import { sendMessage, resumeSession, resetSession, getWorkingDir, getActiveSessions, killSession, killAllSessions, attachWebSocket, revertFiles, saveImagesToTempFiles } from './agentPool.js'
import { processWithTools, generateTasksFromAbstract, type PlanCallbacks, type TaskGenCallbacks } from './gektoTools.js'
import type { ExecutionPlan, Task } from './types.js'
import { randomUUID } from 'crypto'
import { initGekto, getGektoState, abortGekto, setStateCallback, resetGektoSession, restoreGektoSession, getGektoSessionId } from './gektoPersistent.js'
import { getState, mutate, mutateBatch, addClient, removeClient, sendSnapshot, getClients, broadcastActivePlans, broadcastActivePlanId, broadcastSinglePlan, broadcastTask, broadcastAgent, broadcastVisuals, broadcastVisualDelete, broadcastForPath, type Agent, type Message } from '../state.js'
import { persistEntity } from '../entityStore.js'
import fs from 'fs'
import nodePath from 'path'
import { getPostHog, getDistinctId } from '../posthog.js'

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
    const loggedSend = ((data: unknown, ...args: unknown[]) => {
      if (typeof data === 'string') {
        try { logOutgoing(JSON.parse(data)) } catch { /* ignore */ }
      }
      return (originalSend as Function)(data, ...args)
    }) as typeof ws.send
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

          case 'request_snapshot':
            sendSnapshot(ws)
            return

          case 'debug_pool':
            const sessions = getActiveSessions()
            ws.send(JSON.stringify({
              type: 'debug_pool_result',
              sessions,
            }))
            return

          case 'list_gekto_sessions': {
            // List archived master sessions from disk (.gekto/ is in server cwd, not working dir)
            try {
              const agentsDir = nodePath.join(process.cwd(), '.gekto', 'agents')
              const files = fs.readdirSync(agentsDir).filter(f => f.startsWith('master_') && f.endsWith('.json'))
              const currentState = getState()
              const sessions: Array<{ id: string; createdAt: string; preview: string; messageCount: number; isCurrent: boolean }> = []

              for (const file of files) {
                try {
                  const data = JSON.parse(fs.readFileSync(nodePath.join(agentsDir, file), 'utf8'))
                  const msgs = data.messages || []
                  const firstUserMsg = msgs.find((m: { sender: string }) => m.sender === 'user')
                  sessions.push({
                    id: data.id || file.replace('.json', ''),
                    createdAt: data.createdAt || '',
                    preview: firstUserMsg?.text?.substring(0, 80) || '(empty chat)',
                    messageCount: msgs.length,
                    isCurrent: data.id === currentState.currentMasterId,
                  })
                } catch { /* skip corrupted files */ }
              }

              // Current chat always on top, then newest first
              sessions.sort((a, b) => {
                if (a.isCurrent) return -1
                if (b.isCurrent) return 1
                return b.createdAt.localeCompare(a.createdAt)
              })

              ws.send(JSON.stringify({ type: 'gekto_sessions', sessions }))
            } catch {
              ws.send(JSON.stringify({ type: 'gekto_sessions', sessions: [] }))
            }
            return
          }

          case 'kill_all': {
            const killedCount = killAllSessions()
            ws.send(JSON.stringify({
              type: 'kill_all_result',
              killed: killedCount,
            }))
            getPostHog().capture({
              distinctId: getDistinctId(),
              event: 'all agents killed',
              properties: { killed_count: killedCount },
            })
            // Notify about state changes
            for (const session of getActiveSessions()) {
              ws.send(JSON.stringify({ type: 'state', lizardId: session.lizardId, state: 'ready' }))
            }
            return
          }

          // Clear all worker agents from canvas and state
          case 'clear_all_agents': {
            const state = getState()
            // Kill all running agent processes
            killAllSessions()
            // Persist each worker agent as 'done' and remove from memory
            const agentIds = Object.keys(state.agents).filter(id => id !== 'master' && !id.startsWith('master_'))
            for (const agentId of agentIds) {
              const agent = state.agents[agentId]
              if (agent) {
                persistEntity('agents', agentId, {
                  ...agent,
                  status: 'done',
                  completedAt: new Date().toISOString(),
                })
              }
              mutate(`agents.${agentId}`, undefined)
              mutate(`visuals.${agentId}`, undefined)
              broadcastAgent(agentId)
              broadcastVisualDelete(agentId)
            }
            // Clear tasks and plans
            mutate('tasks', {})
            mutate('activePlans', {})
            mutate('activePlanId', null)
            broadcastActivePlans()
            broadcastActivePlanId()
            getPostHog().capture({
              distinctId: getDistinctId(),
              event: 'all agents cleared',
              properties: { agent_count: agentIds.length },
            })
            return
          }

          case 'set_active_plan': {
            mutate('activePlanId', msg.planId ?? null)
            broadcastActivePlanId()
            return
          }

          case 'create_plan': {
            // Set master lizard to working state
            ws.send(JSON.stringify({ type: 'state', lizardId: 'master', state: 'working' }))
            {
              const masterId = getState().currentMasterId
              if (getState().agents[masterId]) {
                mutate(`agents.${masterId}.status`, 'working')
              }
            }

            // Save attached images to temp files
            const planImages = msg.images as string[] | undefined
            let planImagePaths: string[] | undefined
            if (planImages && planImages.length > 0) {
              planImagePaths = saveImagesToTempFiles(planImages)
            }

            // Remember the plan's state before processing so we can restore it
            // if Gekto replies with chat/delegate/error instead of a plan update.
            // Only delete plans that were created as temporary 'planning' entries.
            const planBeforeProcessing = getState().activePlans[msg.planId] ?? null
            const planExistedBefore = planBeforeProcessing !== null
            const previousStatus = planBeforeProcessing?.status

            // Set plan status to 'planning' on the server side (authoritative)
            // so we don't race with the client's save_state message
            if (planBeforeProcessing) {
              mutate(`activePlans.${msg.planId}.status`, 'planning')
            } else {
              // Create temporary plan entry for new plans
              mutate(`activePlans.${msg.planId}`, {
                id: msg.planId,
                status: 'planning',
                originalPrompt: msg.prompt ?? '',
                taskIds: [],
                createdAt: new Date().toISOString(),
              })
            }
            broadcastSinglePlan(msg.planId)
            // Set as active plan
            mutate('activePlanId', msg.planId)
            broadcastActivePlanId()

            try {
              // Server-side accumulators and block counter
              let accThinking = ''
              let accText = ''
              let blockIndex = 0
              // Unique nonce per request so streaming IDs don't collide when
              // the same planId is reused (e.g. plan modifications)
              const requestId = Date.now()

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
                    requestId,
                    text: accText,
                    blockIndex,
                  }))
                },
                onThinking: (text) => {
                  accThinking += text
                  ws.send(JSON.stringify({
                    type: 'gekto_thinking',
                    planId: msg.planId,
                    requestId,
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

              getPostHog().capture({
                distinctId: getDistinctId(),
                event: 'gekto message sent',
                properties: {
                  plan_id: msg.planId,
                  has_images: Boolean(planImagePaths?.length),
                },
              })

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
              // For delegate, the system message handles display — clear the streaming text
              const cleanMessage = planResult.type === 'delegate'
                ? ''
                : (planResult.message || planResult.plan?.reasoning || 'Got it, here\'s the plan.')
              ws.send(JSON.stringify({
                type: 'gekto_text',
                planId: msg.planId,
                requestId,
                text: cleanMessage,
                blockIndex,
                isFinalize: planResult.type === 'delegate',
              }))

              if (planResult.type === 'build' && planResult.plan) {
                // Clean up old tasks when updating an existing plan
                const existingPlan = getState().activePlans[planResult.plan.id]
                if (existingPlan?.taskIds?.length) {
                  for (const oldTaskId of existingPlan.taskIds) {
                    mutate(`tasks.${oldTaskId}`, undefined)
                    broadcastTask(oldTaskId)
                  }
                }

                // Store tasks separately in server state
                const taskMutations: Array<{ path: string; value: unknown }> = []
                if (planResult.tasks) {
                  for (const task of planResult.tasks) {
                    taskMutations.push({ path: `tasks.${task.id}`, value: task })
                  }
                }
                // Store plan + tasks atomically
                mutateBatch([
                  { path: `activePlans.${planResult.plan.id}`, value: planResult.plan },
                  ...taskMutations,
                ])
                broadcastSinglePlan(planResult.plan.id)
                if (planResult.tasks) {
                  for (const task of planResult.tasks) {
                    broadcastTask(task.id)
                  }
                }

                // Set the newly created/updated plan as active
                mutate('activePlanId', planResult.plan.id)
                broadcastActivePlanId()

                ws.send(JSON.stringify({
                  type: 'plan_created',
                  planId: msg.planId,
                  plan: planResult.plan,
                }))

                getPostHog().capture({
                  distinctId: getDistinctId(),
                  event: 'plan created',
                  properties: {
                    plan_id: planResult.plan.id,
                    plan_title: planResult.plan.title,
                    action: planExistedBefore ? 'update_plan' : 'create_plan',
                  },
                })
              } else if (planResult.type === 'remove' && planResult.removedAgents) {
                // Remove agents from server state
                const currentState = getState()
                for (const agentId of planResult.removedAgents) {
                  const agentToRemove = currentState.agents[agentId]
                  if (agentToRemove) {
                    persistEntity('agents', agentId, {
                      ...agentToRemove,
                      status: 'done',
                      completedAt: new Date().toISOString(),
                    })
                  }
                  mutate(`agents.${agentId}`, undefined)
                  broadcastAgent(agentId)
                }
                ws.send(JSON.stringify({
                  type: 'gekto_remove',
                  planId: msg.planId,
                  agents: planResult.removedAgents,
                }))
              } else if (planResult.type === 'delegate' && planResult.delegateAgentId) {
                // Restore plan state — only delete if it was a temporary entry
                if (msg.planId && getState().activePlans[msg.planId]?.status === 'planning') {
                  if (planExistedBefore && previousStatus) {
                    mutate(`activePlans.${msg.planId}.status`, previousStatus)
                    broadcastSinglePlan(msg.planId)
                  } else {
                    mutate(`activePlans.${msg.planId}`, undefined)
                    broadcastSinglePlan(msg.planId)
                  }
                }
                // Send instruction to existing agent
                const targetAgentId = planResult.delegateAgentId
                const delegateState = getState()
                const targetAgent = delegateState.agents[targetAgentId]
                if (targetAgent) {
                  // Update agent status to working
                  mutate(`agents.${targetAgentId}.status`, 'working')
                  broadcastAgent(targetAgentId)
                  // Notify client about delegation
                  const delegateTask = targetAgent.taskId ? delegateState.tasks[targetAgent.taskId] : null
                  ws.send(JSON.stringify({
                    type: 'gekto_delegate',
                    planId: msg.planId,
                    agentId: targetAgentId,
                    agentName: delegateTask?.name || targetAgentId,
                    message: planResult.delegateMessage || '',
                  }))
                  // Fire-and-forget: send message to agent's session without blocking Gekto
                  sendMessage(targetAgentId, planResult.delegateMessage || '', ws).catch(err => {
                    console.error(`[Agent] Delegate to ${targetAgentId} failed:`, err)
                  })
                } else {
                  ws.send(JSON.stringify({
                    type: 'gekto_chat',
                    planId: msg.planId,
                    message: `Agent ${targetAgentId} not found — it may have been removed.`,
                  }))
                }
              } else if (planResult.type === 'chat') {
                // Restore plan state — only delete if it was a temporary entry
                if (msg.planId && getState().activePlans[msg.planId]?.status === 'planning') {
                  if (planExistedBefore && previousStatus) {
                    mutate(`activePlans.${msg.planId}.status`, previousStatus)
                    broadcastSinglePlan(msg.planId)
                  } else {
                    mutate(`activePlans.${msg.planId}`, undefined)
                    broadcastSinglePlan(msg.planId)
                  }
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
              {
                const mid = getState().currentMasterId
                if (getState().agents[mid]) mutate(`agents.${mid}.status`, 'idle')
              }
            } catch (err) {
              console.error('[Agent] Gekto processing failed:', err)
              getPostHog().captureException(err, getDistinctId(), { plan_id: msg.planId })
              ws.send(JSON.stringify({
                type: 'gekto_chat',
                planId: msg.planId,
                message: `Error: ${err instanceof Error ? err.message : 'Processing failed'}`,
              }))
              // Restore plan state on error — only delete if it was a temporary entry
              if (msg.planId && getState().activePlans[msg.planId]?.status === 'planning') {
                if (planExistedBefore && previousStatus) {
                  mutate(`activePlans.${msg.planId}.status`, previousStatus)
                  broadcastSinglePlan(msg.planId)
                } else {
                  mutate(`activePlans.${msg.planId}`, undefined)
                  broadcastSinglePlan(msg.planId)
                }
              }

              ws.send(JSON.stringify({ type: 'gekto_done', planId: msg.planId }))
              ws.send(JSON.stringify({ type: 'state', lizardId: 'master', state: 'ready' }))
              {
                const mid = getState().currentMasterId
                if (getState().agents[mid]) mutate(`agents.${mid}.status`, 'idle')
              }
            }
            return
          }

          case 'generate_tasks': {
            const currentState = getState()
            const genPlan = currentState.activePlans[msg.planId]
            if (!genPlan) {
              ws.send(JSON.stringify({ type: 'error', message: 'Plan not found' }))
              return
            }

            // Set master to working while generating
            ws.send(JSON.stringify({ type: 'state', lizardId: 'master', state: 'working' }))
            {
              const mid = currentState.currentMasterId
              if (currentState.agents[mid]) mutate(`agents.${mid}.status`, 'working')
            }

            // Clean up old tasks before regenerating
            if (genPlan.taskIds?.length) {
              for (const oldTaskId of genPlan.taskIds) {
                mutate(`tasks.${oldTaskId}`, undefined)
                broadcastTask(oldTaskId)
              }
              mutate(`activePlans.${msg.planId}.taskIds`, [])
            }

            // Update plan status
            mutate(`activePlans.${msg.planId}.status`, 'generating_prompts')
            broadcastSinglePlan(msg.planId)

            try {
              const requestId = Date.now()
              const generatedTaskIds = new Set<string>()
              const genCallbacks: TaskGenCallbacks = {
                onToolStart: (tool, input) => {
                  ws.send(JSON.stringify({ type: 'gekto_tool_start', planId: msg.planId, requestId, tool, input: input ? JSON.stringify(input).slice(0, 200) : undefined }))
                },
                onToolEnd: (tool) => {
                  ws.send(JSON.stringify({ type: 'gekto_tool_end', planId: msg.planId, requestId, tool }))
                },
                onThinking: (text) => {
                  ws.send(JSON.stringify({ type: 'gekto_thinking', planId: msg.planId, requestId, text }))
                },
                onTaskReady: (task) => {
                  // Store and broadcast each task (handles both initial skeleton and detail update)
                  const isNew = !generatedTaskIds.has(task.id)
                  generatedTaskIds.add(task.id)
                  mutate(`tasks.${task.id}`, task)
                  if (isNew) {
                    mutate(`activePlans.${msg.planId}.taskIds`, [...generatedTaskIds])
                  }
                  broadcastTask(task.id)
                  broadcastSinglePlan(msg.planId)
                  ws.send(JSON.stringify({
                    type: 'task_ready',
                    planId: msg.planId,
                    taskId: task.id,
                  }))
                },
                onTasksGenerated: (tasks) => {
                  // Final: update plan status to ready
                  mutate(`activePlans.${msg.planId}.taskIds`, [...generatedTaskIds])
                  mutate(`activePlans.${msg.planId}.status`, 'prompts_ready')
                  broadcastSinglePlan(msg.planId)

                  ws.send(JSON.stringify({
                    type: 'tasks_generated',
                    planId: msg.planId,
                    taskCount: tasks.length,
                  }))

                  getPostHog().capture({
                    distinctId: getDistinctId(),
                    event: 'plan tasks generated',
                    properties: {
                      plan_id: msg.planId,
                      task_count: tasks.length,
                    },
                  })
                },
                onError: (error) => {
                  ws.send(JSON.stringify({
                    type: 'gekto_chat',
                    planId: msg.planId,
                    message: `Error generating tasks: ${error}`,
                  }))
                  // Revert plan status to draft
                  mutate(`activePlans.${msg.planId}.status`, 'draft')
                  broadcastSinglePlan(msg.planId)
                },
              }

              await generateTasksFromAbstract(genPlan, getWorkingDir(), genCallbacks)
            } catch (err) {
              console.error('[Agent] Task generation failed:', err)
              getPostHog().captureException(err, getDistinctId(), { plan_id: msg.planId })
              ws.send(JSON.stringify({
                type: 'gekto_chat',
                planId: msg.planId,
                message: `Error generating tasks: ${err instanceof Error ? err.message : 'Failed'}`,
              }))
              mutate(`activePlans.${msg.planId}.status`, 'draft')
              broadcastSinglePlan(msg.planId)
            }

            ws.send(JSON.stringify({ type: 'state', lizardId: 'master', state: 'ready' }))
            {
              const mid = getState().currentMasterId
              if (getState().agents[mid]) mutate(`agents.${mid}.status`, 'idle')
            }
            return
          }

          case 'execute_plan': {
            // Update plan status in server state
            const currentState = getState()
            if (currentState.activePlans[msg.planId]) {
              mutate(`activePlans.${msg.planId}.status`, 'executing')
              broadcastSinglePlan(msg.planId)
            }
            getPostHog().capture({
              distinctId: getDistinctId(),
              event: 'plan executed',
              properties: {
                plan_id: msg.planId,
                task_count: currentState.activePlans[msg.planId]?.taskIds?.length ?? 0,
              },
            })
            return
          }

          case 'cancel_plan': {
            getPostHog().capture({
              distinctId: getDistinctId(),
              event: 'plan canceled',
              properties: { plan_id: msg.planId },
            })
            const currentState = getState()
            const cancelPlan = currentState.activePlans[msg.planId]
            if (cancelPlan) {
              // Collect agents assigned to this plan's tasks
              const planAgentIds = new Set<string>()
              if (cancelPlan.taskIds?.length) {
                for (const taskId of cancelPlan.taskIds) {
                  const task = currentState.tasks[taskId]
                  if (task?.assignedAgentId) {
                    planAgentIds.add(task.assignedAgentId)
                  }
                  mutate(`tasks.${taskId}`, undefined)
                  broadcastTask(taskId)
                }
              }
              // Clean up agents that were assigned to this plan
              for (const agentId of planAgentIds) {
                const agent = currentState.agents[agentId]
                if (agent) {
                  // Kill running session if any
                  killSession(agentId)
                  persistEntity('agents', agentId, {
                    ...agent,
                    status: 'done',
                    completedAt: new Date().toISOString(),
                  })
                  mutate(`agents.${agentId}`, undefined)
                  mutate(`visuals.${agentId}`, undefined)
                  broadcastAgent(agentId)
                  broadcastVisualDelete(agentId)
                  // Clean up fileChanges for this agent
                  for (const [encodedPath, fc] of Object.entries(currentState.fileChanges)) {
                    if (fc.agentId === agentId) {
                      mutate(`fileChanges.${encodedPath}`, undefined)
                    }
                  }
                }
              }
              mutate(`activePlans.${msg.planId}`, undefined)
              broadcastSinglePlan(msg.planId)
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
            getPostHog().capture({
              distinctId: getDistinctId(),
              event: 'worker agent spawned',
              properties: {
                agent_id: agent.id,
                task_id: task.id,
                plan_id: task.planId,
              },
            })
            return
          }

          // Client updates a chat message list — store on agent
          case 'save_chat': {
            let { agentId } = msg as { agentId: string; messages: Message[] }
            const { messages } = msg as { agentId: string; messages: Message[] }
            const state = getState()

            // Resolve 'master' to the current master session ID
            const isMasterChat = agentId === 'master' || agentId.startsWith('master_')
            if (agentId === 'master') {
              agentId = state.currentMasterId
            }

            // Don't overwrite archived sessions — save_chat may arrive late after archive
            if (state.agents[agentId]?.status === 'done') return

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
            // Don't broadcast master agent changes — it's not a worker lizard
            if (!isMasterChat) {
              broadcastAgent(agentId)
            }
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
              const taskState = getState().tasks[msg.taskId]
              const agentId = taskState?.assignedAgentId
              const mutations: Array<{ path: string; value: unknown }> = [
                { path: `tasks.${msg.taskId}.status`, value: 'pending_testing' },
              ]
              if (msg.result) {
                mutations.push({ path: `tasks.${msg.taskId}.result`, value: msg.result })
              }
              if (agentId && getState().agents[agentId]) {
                mutations.push({ path: `agents.${agentId}.status`, value: 'done' })
                mutations.push({ path: `agents.${agentId}.completedAt`, value: new Date().toISOString() })
              }
              mutateBatch(mutations)
              broadcastTask(msg.taskId)
              if (agentId) broadcastAgent(agentId)
              getPostHog().capture({
                distinctId: getDistinctId(),
                event: 'task completed',
                properties: {
                  task_id: msg.taskId,
                  task_name: taskState?.name,
                  plan_id: taskState?.planId,
                  agent_id: agentId,
                },
              })
            }
            return
          }

          case 'task_failed': {
            if (msg.taskId) {
              const taskState = getState().tasks[msg.taskId]
              const agentId = taskState?.assignedAgentId
              const mutations: Array<{ path: string; value: unknown }> = [
                { path: `tasks.${msg.taskId}.status`, value: 'failed' },
                { path: `tasks.${msg.taskId}.error`, value: msg.error },
              ]
              if (agentId && getState().agents[agentId]) {
                mutations.push({ path: `agents.${agentId}.status`, value: 'error' })
              }
              mutateBatch(mutations)
              broadcastTask(msg.taskId)
              if (agentId) broadcastAgent(agentId)
              getPostHog().capture({
                distinctId: getDistinctId(),
                event: 'task failed',
                properties: {
                  task_id: msg.taskId,
                  task_name: taskState?.name,
                  plan_id: taskState?.planId,
                  agent_id: agentId,
                  error: msg.error,
                },
              })
            }
            return
          }

          case 'task_started': {
            if (msg.taskId) {
              const taskState = getState().tasks[msg.taskId]
              mutateBatch([
                { path: `tasks.${msg.taskId}.status`, value: 'in_progress' },
                { path: `tasks.${msg.taskId}.assignedAgentId`, value: msg.lizardId },
              ])
              broadcastTask(msg.taskId)
              getPostHog().capture({
                distinctId: getDistinctId(),
                event: 'task started',
                properties: {
                  task_id: msg.taskId,
                  task_name: taskState?.name,
                  plan_id: taskState?.planId,
                  agent_id: msg.lizardId,
                },
              })
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
            // Mark task as completed (keep it in plan.taskIds)
            if (msg.taskId) {
              mutate(`tasks.${msg.taskId}.status`, 'completed')
              broadcastTask(msg.taskId)
            }
            // Remove linked agent
            if (msg.agentId) {
              const agentToResolve = getState().agents[msg.agentId]
              if (agentToResolve) {
                persistEntity('agents', msg.agentId, {
                  ...agentToResolve,
                  status: 'done',
                  completedAt: new Date().toISOString(),
                })
              }
              mutate(`agents.${msg.agentId}`, undefined)
              mutate(`visuals.${msg.agentId}`, undefined)
              broadcastAgent(msg.agentId)
              broadcastVisualDelete(msg.agentId)
            }
            // Check if all tasks in the task's plan are now completed
            const state = getState()
            const task = state.tasks[msg.taskId]
            const taskPlanId = task?.planId
            if (taskPlanId && state.activePlans[taskPlanId]) {
              const plan = state.activePlans[taskPlanId]
              const allCompleted = plan.taskIds.every(id => {
                const t = state.tasks[id]
                return t?.status === 'completed'
              })
              if (allCompleted) {
                mutateBatch([
                  { path: `activePlans.${taskPlanId}.status`, value: 'completed' },
                  { path: `activePlans.${taskPlanId}.completedAt`, value: new Date().toISOString() },
                ])
                broadcastSinglePlan(taskPlanId)
              }
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

            // Mark current master as archived — always save messages from the request
            if (currentState.agents[oldMasterId]) {
              mutateBatch([
                { path: `agents.${oldMasterId}.messages`, value: archiveMessages },
                { path: `agents.${oldMasterId}.status`, value: 'done' },
                { path: `agents.${oldMasterId}.completedAt`, value: new Date().toISOString() },
                { path: `agents.${oldMasterId}.sessionId`, value: archiveSessionId },
              ])
            } else {
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

            // Remove old master from in-memory state (already persisted to disk above)
            mutate(`agents.${oldMasterId}`, undefined)

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

          case 'delete_gekto_session': {
            const { sessionId: deleteId } = msg as { sessionId: string }
            // Don't allow deleting current session
            const currentState = getState()
            if (deleteId === currentState.currentMasterId) return

            // Remove from memory if loaded
            if (currentState.agents[deleteId]) {
              mutate(`agents.${deleteId}`, undefined)
            }
            // Delete file from disk
            try {
              const filePath = nodePath.join(process.cwd(), '.gekto', 'agents', `${deleteId}.json`)
              if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath)
              }
            } catch { /* ignore */ }
            return
          }

          case 'restore_gekto_session': {
            const { sessionId: restoreId } = msg as { sessionId: string }
            const currentState = getState()

            // Load agent from memory or disk
            let agentSession = currentState.agents[restoreId]
            if (!agentSession) {
              try {
                const filePath = nodePath.join(process.cwd(), '.gekto', 'agents', `${restoreId}.json`)
                if (fs.existsSync(filePath)) {
                  agentSession = JSON.parse(fs.readFileSync(filePath, 'utf8'))
                }
              } catch { /* ignore */ }
            }

            if (agentSession?.messages) {
              // Update server state
              mutate(`agents.${restoreId}`, { ...agentSession, status: 'idle' })
              mutate('currentMasterId', restoreId)

              if (agentSession.sessionId) {
                restoreGektoSession(agentSession.sessionId)
              }

              // Return messages directly — client sets them, no broadcast needed
              ws.send(JSON.stringify({
                type: 'session_restored',
                sessionId: restoreId,
                currentMasterId: restoreId,
                messages: agentSession.messages,
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
              getPostHog().capture({
                distinctId: getDistinctId(),
                event: 'agent message sent',
                properties: {
                  agent_id: lizardId,
                  has_images: Boolean(images?.length),
                },
              })
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
            getPostHog().capture({
              distinctId: getDistinctId(),
              event: 'agent reset',
              properties: { agent_id: lizardId },
            })
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
            getPostHog().capture({
              distinctId: getDistinctId(),
              event: 'files reverted',
              properties: {
                agent_id: lizardId,
                reverted_count: revertResult.reverted.length,
                failed_count: revertResult.failed.length,
              },
            })
            // Remove reverted file changes from agent state
            const agentState = getState().agents[lizardId]
            if (agentState?.fileChanges) {
              const revertedSet = new Set(revertResult.reverted)
              const remaining = agentState.fileChanges.filter(fc => !revertedSet.has(fc.filePath))
              mutate(`agents.${lizardId}.fileChanges`, remaining)
              // Also remove from agent's fileChangePaths
              if (agentState.fileChangePaths) {
                mutate(`agents.${lizardId}.fileChangePaths`, agentState.fileChangePaths.filter(p => !revertedSet.has(p)))
              }
              broadcastAgent(lizardId)
            }
            // Clean up top-level fileChanges entries
            for (const filePath of revertResult.reverted) {
              const encodedPath = filePath.replace(/\//g, '--')
              mutate(`fileChanges.${encodedPath}`, undefined)
            }
            break
          }

          case 'kill': {
            // For master, abort the persistent Gekto process instead of killing session
            let killed: boolean
            if (lizardId === 'master') {
              // Pass chat history so restarted process can replay context
              const masterAgent = getState().agents[getState().currentMasterId]
              killed = abortGekto(masterAgent?.messages as import('./gektoPersistent.js').StoredMessage[] | undefined)
            } else {
              killed = killSession(lizardId)
              // Update agent status in server state
              if (killed && getState().agents[lizardId]) {
                mutate(`agents.${lizardId}.status`, 'error')
                broadcastAgent(lizardId)
              }
            }
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
