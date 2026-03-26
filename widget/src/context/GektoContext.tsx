import { createContext, useContext, useState, useCallback, useMemo, useEffect, useRef, type ReactNode } from 'react'
import { useSwarm } from './SwarmContext'
import { useAgent } from './AgentContext'
import { useStore } from '../store/store'
import { useServerState, type ExecutionPlan, type Task } from '../hooks/useServerState'

// === Types ===

type PlanStatus = 'planning' | 'draft' | 'ready' | 'generating_prompts' | 'prompts_ready' | 'executing' | 'completed' | 'failed'
type TaskStatus = 'pending' | 'in_progress' | 'pending_testing' | 'completed' | 'failed'

type ExecutionStrategy = 'parallel-files' | 'sequential' | 'hybrid'
type Provider = 'claude-code' | 'claude-api' | 'openai' | 'local'

interface GektoConfig {
  strategy: ExecutionStrategy
  defaultProvider: Provider
  maxParallelAgents: number
  autoSpawnWorkers: boolean
}

interface GektoContextValue {
  // Current plan (selected plan from server state)
  currentPlan: ExecutionPlan | null

  // Multiple plans support
  activePlans: Record<string, ExecutionPlan>
  selectedPlanId: string | null
  isCreatingNewPlan: boolean
  selectPlan: (planId: string) => void
  createNewPlan: () => void

  // Configuration
  config: GektoConfig

  // Mode: plan (default) or direct
  directMode: boolean
  setDirectMode: (enabled: boolean) => void

  // Plan actions
  createPlan: (prompt: string, images?: string[]) => Promise<void>
  generateTasks: () => void
  executePlan: () => Promise<void>
  buildPlan: () => Promise<void>
  cancelPlan: () => void

  // Task monitoring
  getTaskStatus: (taskId: string) => TaskStatus | undefined
  getTaskByLizardId: (lizardId: string) => Task | undefined
  markTaskResolved: (taskId: string) => void
  retryTask: (taskId: string) => void
  runTask: (taskId: string) => void
  runAvailableTasks: () => void
  removeTask: (taskId: string) => void
  markTaskInProgress: (lizardId: string) => void

  // Delegation
  delegatePrompt: (prompt: string) => void

  // UI state
  isPlanPanelOpen: boolean
  openPlanPanel: () => void
  closePlanPanel: () => void
}

const DEFAULT_CONFIG: GektoConfig = {
  strategy: 'parallel-files',
  defaultProvider: 'claude-code',
  maxParallelAgents: 5,
  autoSpawnWorkers: true,
}

const GektoContext = createContext<GektoContextValue | null>(null)

export function useGekto() {
  const context = useContext(GektoContext)
  if (!context) {
    throw new Error('useGekto must be used within a GektoProvider')
  }
  return context
}

interface GektoProviderProps {
  children: ReactNode
}

// Accumulator for streaming text deltas from Gekto during planning
// No longer needed — server accumulates per block

export function GektoProvider({ children }: GektoProviderProps) {
  // Access SwarmContext for chat control
  const { openChat } = useSwarm()

  // Server state — plans come from here
  const { state: serverState, send } = useServerState()
  const activePlans = serverState.activePlans
  // activePlanId is server-authoritative — the plan the user is viewing/editing
  const selectedPlanId = serverState.activePlanId
  // When true, user clicked "+" to start a new plan — don't auto-select existing plans
  const [isCreatingNewPlan, setIsCreatingNewPlan] = useState(false)

  // Derive current plan from server-authoritative activePlanId
  const currentPlan = useMemo(() => {
    if (selectedPlanId && activePlans[selectedPlanId]) {
      return activePlans[selectedPlanId]
    }
    return null
  }, [selectedPlanId, activePlans])

  // Auto-select: if activePlanId is stale (plan was deleted), pick the most recent plan
  // But don't auto-select if user is creating a new plan
  useEffect(() => {
    if (isCreatingNewPlan) return // user deliberately cleared selection
    if (selectedPlanId && activePlans[selectedPlanId]) return // still valid
    const planIds = Object.keys(activePlans)
    if (planIds.length > 0) {
      const sorted = planIds.sort((a, b) => {
        const pa = activePlans[a]
        const pb = activePlans[b]
        return (pb.createdAt || '').localeCompare(pa.createdAt || '')
      })
      send({ type: 'set_active_plan', planId: sorted[0] })
    } else if (selectedPlanId !== null) {
      send({ type: 'set_active_plan', planId: null })
    }
  }, [selectedPlanId, activePlans, isCreatingNewPlan, send])

  const selectPlan = useCallback((planId: string) => {
    send({ type: 'set_active_plan', planId })
    setIsCreatingNewPlan(false)
  }, [send])

  const createNewPlan = useCallback(() => {
    send({ type: 'set_active_plan', planId: null })
    setIsCreatingNewPlan(true)
  }, [send])

  // Resolve tasks from currentPlan.taskIds + state.tasks
  const planTasks = useMemo((): Task[] => {
    if (!currentPlan) return []
    return (currentPlan.taskIds || [])
      .map(id => serverState.tasks[id])
      .filter((t): t is Task => !!t)
  }, [currentPlan, serverState.tasks])

  // Get agents from store
  const storeAgents = useStore((s) => s.agents)
  // Access AgentContext for sending messages and WebSocket
  const { sendMessage, getWebSocket } = useAgent()
  const [config] = useState<GektoConfig>(DEFAULT_CONFIG)
  const [isPlanPanelOpen, setIsPlanPanelOpen] = useState(false)
  const [directMode, setDirectMode] = useState(false)

  // Send message to Gekto - server will decide if planning is needed
  const createPlan = useCallback(async (prompt: string, images?: string[]) => {
    const ws = getWebSocket()
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return
    }

    // If there's an active plan and user didn't click "+", reuse the active plan's ID
    // so the message applies to the current plan. Only generate a new ID for new plans.
    const planId = (!isCreatingNewPlan && selectedPlanId) ? selectedPlanId : `plan_test_${Date.now()}`

    // Include current agents so server knows what exists
    const currentAgents = Object.values(storeAgents).map(a => ({
      id: a.id,
      isWorker: a.id.startsWith('worker_'),
    }))

    const payload: Record<string, unknown> = {
      type: 'create_plan',
      prompt,
      planId,
      mode: directMode ? 'direct' : 'plan',
      lizards: currentAgents,
    }
    if (images && images.length > 0) {
      payload.images = images
    }
    ws.send(JSON.stringify(payload))
  }, [getWebSocket, storeAgents, directMode, isCreatingNewPlan, selectedPlanId])

  // Generate tasks from plan abstract (converts abstract → structured tasks with prompts)
  const generateTasks = useCallback(() => {
    if (!currentPlan || currentPlan.status !== 'draft') return

    const ws = getWebSocket()
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    ws.send(JSON.stringify({
      type: 'generate_tasks',
      planId: currentPlan.id,
    }))
  }, [getWebSocket, currentPlan])

  // Use refs to always have the latest plan/tasks without stale closures
  const currentPlanRef = useRef(currentPlan)
  currentPlanRef.current = currentPlan
  const planTasksRef = useRef(planTasks)
  planTasksRef.current = planTasks

  // Track dispatched task IDs to prevent double-dispatch (send() is async WebSocket round-trip)
  const dispatchedTaskIdsRef = useRef(new Set<string>())

  // Execute the current plan
  const executePlan = useCallback(async () => {
    const plan = currentPlanRef.current
    const tasks = planTasksRef.current
    if (!plan) return
    if (plan.status !== 'prompts_ready') return

    const ws = getWebSocket()
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    // Update plan status to executing
    send({ type: 'save_state', path: `activePlans.${plan.id}.status`, value: 'executing' })

    // Notify server that execution started
    ws.send(JSON.stringify({
      type: 'execute_plan',
      planId: plan.id,
    }))

    // Find tasks that can run (deps done = pending_testing or completed)
    const doneTaskIds = new Set(
      tasks.filter(t => t.status === 'completed' || t.status === 'pending_testing').map(t => t.id)
    )

    const tasksToRun = tasks.filter(task => {
      if (task.status !== 'pending') return false
      return (task.dependencies ?? []).every(depId => doneTaskIds.has(depId))
    })

    // Create agents and tasks in store for each task to run
    // Mark as dispatched to prevent auto-run effect from duplicating
    const taskAssignments: { taskId: string; agentId: string; prompt: string }[] = []
    for (const task of tasksToRun) {
      dispatchedTaskIdsRef.current.add(task.id)
      const agentId = `worker_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

      // Create task+agent in server state
      send({
        type: 'create_task_and_agent',
        task: {
          id: task.id,
          name: task.description.slice(0, 50),
          description: task.description,
          prompt: task.prompt,
          status: 'in_progress',
          planId: plan.id,
          files: task.files,
          assignedAgentId: agentId,
          dependencies: task.dependencies,
        },
        agent: {
          id: agentId,
          taskId: task.id,
          personaId: 'plain',
          status: 'working',
        },
      })

      taskAssignments.push({ taskId: task.id, agentId, prompt: task.prompt })

      // Notify server about task start
      ws.send(JSON.stringify({
        type: 'task_started',
        planId: plan.id,
        taskId: task.id,
        lizardId: agentId,
      }))
    }

    // Send task prompts to workers (with delay to ensure state is updated)
    setTimeout(() => {
      for (const { taskId, agentId, prompt } of taskAssignments) {
        const taskObj = tasks.find(t => t.id === taskId)
        const taskContext = [
          `[TASK_CONTEXT]`,
          `Task ID: ${taskId}`,
          `Task: ${taskObj?.description || 'Unknown'}`,
          taskObj?.files?.length ? `Files to modify: ${taskObj.files.join(', ')}` : null,
          `Plan goal: ${plan.originalPrompt}`,
          `[/TASK_CONTEXT]`,
          '',
        ].filter(Boolean).join('\n')

        sendMessage(agentId, taskContext + prompt)
      }
    }, 100)
  }, [getWebSocket, sendMessage, send])

  // Build: wire all components together using the plan's buildPrompt
  const buildPlan = useCallback(async () => {
    if (!currentPlan?.buildPrompt) return

    const ws = getWebSocket()
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    const agentId = `worker_build_${Date.now()}`
    const taskId = `${currentPlan.id.replace(/^plan_/, '')}_build`

    // Create task+agent in server state
    send({
      type: 'create_task_and_agent',
      task: {
        id: taskId,
        name: 'Build: wire components',
        description: 'Wire all components together',
        prompt: currentPlan.buildPrompt,
        status: 'in_progress',
        planId: currentPlan.id,
        files: [],
        assignedAgentId: agentId,
        dependencies: [],
      },
      agent: {
        id: agentId,
        taskId,
        personaId: 'plain',
        status: 'working',
      },
    })

    ws.send(JSON.stringify({
      type: 'task_started',
      planId: currentPlan.id,
      taskId,
      lizardId: agentId,
    }))

    // Add build task ID to plan
    const updatedTaskIds = [...(currentPlan.taskIds || []), taskId]
    send({ type: 'save_state', path: `activePlans.${currentPlan.id}.taskIds`, value: updatedTaskIds })
    send({ type: 'save_state', path: `activePlans.${currentPlan.id}.status`, value: 'executing' })

    // Send prompt to worker with task context
    setTimeout(() => {
      const taskContext = [
        `[TASK_CONTEXT]`,
        `Task: Build — wire all components together`,
        `Plan goal: ${currentPlan.originalPrompt}`,
        `[/TASK_CONTEXT]`,
        '',
      ].join('\n')

      sendMessage(agentId, taskContext + currentPlan.buildPrompt!)
    }, 100)
  }, [currentPlan, getWebSocket, sendMessage, send])

  // Cancel the current plan
  const cancelPlan = useCallback(() => {
    if (!currentPlan) return

    const ws = getWebSocket()
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'cancel_plan',
        planId: currentPlan.id,
      }))
    }

    send({ type: 'save_state', path: `activePlans.${currentPlan.id}`, value: undefined })
    // Auto-select another plan if any remain
    const remaining = Object.keys(activePlans).filter(id => id !== currentPlan.id)
    if (remaining.length > 0) {
      send({ type: 'set_active_plan', planId: remaining[0] })
    } else {
      send({ type: 'set_active_plan', planId: null })
      setIsPlanPanelOpen(false)
    }
  }, [currentPlan, activePlans, getWebSocket, send])

  // Get status of a specific task
  const getTaskStatus = useCallback((taskId: string): TaskStatus | undefined => {
    return serverState.tasks[taskId]?.status
  }, [serverState.tasks])

  // Get task assigned to a specific agent
  const getTaskByLizardId = useCallback((lizardId: string): Task | undefined => {
    return planTasks.find(t => t.assignedAgentId === lizardId)
  }, [planTasks])

  // Mark a task as resolved - removes task and linked agent
  const markTaskResolved = useCallback((taskId: string) => {
    const task = serverState.tasks[taskId]
    const agentId = task?.assignedAgentId

    send({
      type: 'mark_task_resolved',
      taskId,
      agentId,
    })
  }, [serverState.tasks, send])

  // Remove a task from the plan entirely
  const removeTask = useCallback((taskId: string) => {
    const task = serverState.tasks[taskId]
    const agentId = task?.assignedAgentId
    const plan = currentPlanRef.current

    // Remove task from plan.taskIds
    if (plan) {
      const remainingIds = plan.taskIds.filter(id => id !== taskId)
      send({ type: 'save_state', path: `activePlans.${plan.id}.taskIds`, value: remainingIds })
    }

    // Delete task state
    send({ type: 'save_state', path: `tasks.${taskId}`, value: undefined })

    // Remove linked agent
    if (agentId) {
      send({ type: 'save_state', path: `agents.${agentId}`, value: undefined })
      send({ type: 'save_state', path: `visuals.${agentId}`, value: undefined })
    }
  }, [serverState.tasks, send])

  // Retry a task
  const retryTask = useCallback((taskId: string) => {
    const task = serverState.tasks[taskId]
    const agentId = task?.assignedAgentId

    if (task) {
      send({ type: 'save_state', path: `tasks.${taskId}.status`, value: 'pending' })
      send({ type: 'save_state', path: `tasks.${taskId}.error`, value: undefined })
      send({ type: 'save_state', path: `tasks.${taskId}.result`, value: undefined })
    }

    if (agentId) {
      openChat(agentId, 'task')
    }
  }, [serverState.tasks, openChat, send])

  // Manually run a single pending task
  const runTask = useCallback((taskId: string) => {
    if (!currentPlan) return

    const task = serverState.tasks[taskId]
    if (!task || (task.status !== 'pending' && task.status !== 'failed')) return

    const ws = getWebSocket()
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    const agentId = `worker_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

    // Create task+agent in server state
    send({
      type: 'create_task_and_agent',
      task: {
        id: task.id,
        name: task.description.slice(0, 50),
        description: task.description,
        prompt: task.prompt,
        status: 'in_progress',
        planId: currentPlan.id,
        files: task.files,
        assignedAgentId: agentId,
        dependencies: task.dependencies,
      },
      agent: {
        id: agentId,
        taskId: task.id,
        personaId: 'plain',
        status: 'working',
      },
    })

    ws.send(JSON.stringify({
      type: 'task_started',
      planId: currentPlan.id,
      taskId: task.id,
      lizardId: agentId,
    }))

    // Update plan status
    if (currentPlan.status === 'ready' || currentPlan.status === 'prompts_ready') {
      send({ type: 'save_state', path: `activePlans.${currentPlan.id}.status`, value: 'executing' })
    }

    // Send prompt to worker with task context
    setTimeout(() => {
      const taskContext = [
        `[TASK_CONTEXT]`,
        `Task ID: ${task.id}`,
        `Task: ${task.description}`,
        task.files?.length ? `Files to modify: ${task.files.join(', ')}` : null,
        `Plan goal: ${currentPlan.originalPrompt}`,
        `[/TASK_CONTEXT]`,
        '',
      ].filter(Boolean).join('\n')

      sendMessage(agentId, taskContext + task.prompt)
    }, 100)
  }, [currentPlan, serverState.tasks, getWebSocket, sendMessage, send])

  // Run all pending tasks whose dependencies are satisfied
  const runAvailableTasks = useCallback(() => {
    const plan = currentPlanRef.current
    if (!plan) return

    const tasks = planTasksRef.current
    const ws = getWebSocket()
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    // A dep is "done" if agent finished (pending_testing) or user approved (completed)
    const doneTaskIds = new Set(
      tasks.filter(t => t.status === 'completed' || t.status === 'pending_testing').map(t => t.id)
    )

    const available = tasks.filter(task => {
      if (task.status !== 'pending') return false
      if (dispatchedTaskIdsRef.current.has(task.id)) return false
      return (task.dependencies ?? []).every(depId => doneTaskIds.has(depId))
    })

    if (!available.length) return

    // Mark as dispatched before sending to prevent double-dispatch
    for (const task of available) {
      dispatchedTaskIdsRef.current.add(task.id)
    }

    // Update plan status if needed
    if (plan.status === 'prompts_ready') {
      send({ type: 'save_state', path: `activePlans.${plan.id}.status`, value: 'executing' })
    }

    const assignments: { taskId: string; agentId: string; prompt: string; description: string; files: string[] }[] = []

    for (let i = 0; i < available.length; i++) {
      const task = available[i]
      const agentId = `worker_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 6)}`

      send({
        type: 'create_task_and_agent',
        task: {
          id: task.id,
          name: task.description.slice(0, 50),
          description: task.description,
          prompt: task.prompt,
          status: 'in_progress',
          planId: plan.id,
          files: task.files,
          assignedAgentId: agentId,
          dependencies: task.dependencies,
        },
        agent: {
          id: agentId,
          taskId: task.id,
          personaId: 'plain',
          status: 'working',
        },
      })

      ws.send(JSON.stringify({
        type: 'task_started',
        planId: plan.id,
        taskId: task.id,
        lizardId: agentId,
      }))

      assignments.push({ taskId: task.id, agentId, prompt: task.prompt, description: task.description, files: task.files ?? [] })
    }

    setTimeout(() => {
      for (const { taskId, agentId, prompt, description, files } of assignments) {
        const taskContext = [
          `[TASK_CONTEXT]`,
          `Task ID: ${taskId}`,
          `Task: ${description}`,
          files?.length ? `Files to modify: ${files.join(', ')}` : null,
          `Plan goal: ${plan.originalPrompt}`,
          `[/TASK_CONTEXT]`,
          '',
        ].filter(Boolean).join('\n')

        sendMessage(agentId, taskContext + prompt)
      }
    }, 100)
  }, [getWebSocket, sendMessage, send])

  // Mark a task as in_progress when user sends message to linked worker
  const markTaskInProgress = useCallback((agentId: string) => {
    const task = planTasks.find(t => t.assignedAgentId === agentId)
    if (task && task.status === 'pending') {
      send({ type: 'save_state', path: `tasks.${task.id}.status`, value: 'in_progress' })
    }
  }, [planTasks, send])

  // Delegate a follow-up prompt to appropriate agent
  const delegatePrompt = useCallback((prompt: string) => {
    const ws = getWebSocket()
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    ws.send(JSON.stringify({
      type: 'delegate_prompt',
      prompt,
      planId: currentPlan?.id,
    }))
  }, [currentPlan, getWebSocket])

  // UI state
  const openPlanPanel = useCallback(() => setIsPlanPanelOpen(true), [])
  const closePlanPanel = useCallback(() => setIsPlanPanelOpen(false), [])

  // Handle incoming WebSocket messages for plan updates
  const handlePlanMessage = useCallback((msg: {
    type: string
    plan?: ExecutionPlan
    planId?: string
    taskId?: string
    lizardId?: string
    status?: TaskStatus
    result?: string
    error?: string
    prompt?: string
    message?: string
    removedAgents?: string[]
    agentId?: string
    agentName?: string
    mode?: string
    text?: string
    timing?: { classifyMs?: number; workMs?: number }
  }) => {
    switch (msg.type) {
      case 'planning_started': {
        // Server already set the plan status to 'planning' (or created a temporary entry).
        // Just select the plan and open the panel.
        const planId = msg.planId!
        setIsCreatingNewPlan(false)
        break
      }

      case 'gekto_text':
        // Server sends accumulated text per block — use requestId + blockIndex for unique IDs
        // requestId ensures IDs don't collide across plan modification requests
        if (msg.text) {
          const textBlockIdx = (msg as Record<string, unknown>).blockIndex ?? 0
          const textReqId = (msg as Record<string, unknown>).requestId ?? msg.planId
          const listener = (window as unknown as { __agentMessageListeners?: Map<string, (message: { id: string; text: string; sender: 'bot'; timestamp: Date; isStreaming?: boolean }) => void> }).__agentMessageListeners?.get('master')
          if (listener) {
            listener({
              id: `gekto_streaming_${textReqId}_${textBlockIdx}`,
              text: msg.text,
              sender: 'bot',
              timestamp: new Date(),
              isStreaming: true,
            })
          }
        }
        break

      case 'gekto_thinking':
        // Server sends accumulated thinking per block — use requestId + blockIndex for unique IDs
        if (msg.text) {
          const thinkBlockIdx = (msg as Record<string, unknown>).blockIndex ?? 0
          const thinkReqId = (msg as Record<string, unknown>).requestId ?? msg.planId
          const listener = (window as unknown as { __agentMessageListeners?: Map<string, (message: { id: string; text: string; sender: 'bot'; timestamp: Date; isStreaming?: boolean; isThinking?: boolean }) => void> }).__agentMessageListeners?.get('master')
          if (listener) {
            listener({
              id: `gekto_thinking_${thinkReqId}_${thinkBlockIdx}`,
              text: msg.text,
              sender: 'bot',
              timestamp: new Date(),
              isStreaming: true,
              isThinking: true,
            })
          }
        }
        break

      case 'gekto_tool_start': {
        const toolMsg = msg as unknown as Record<string, unknown>
        const toolListener = (window as unknown as { __agentMessageListeners?: Map<string, (message: { id: string; text: string; sender: 'bot'; timestamp: Date; toolUse?: { tool: string; input?: string; status: string; startTime: Date } }) => void> }).__agentMessageListeners?.get('master')
        if (toolListener && toolMsg.tool) {
          toolListener({
            id: `gekto_tool_${toolMsg.requestId}_${toolMsg.tool}_${Date.now()}`,
            text: '',
            sender: 'bot',
            timestamp: new Date(),
            toolUse: {
              tool: toolMsg.tool as string,
              input: toolMsg.input as string | undefined,
              status: 'running',
              startTime: new Date(),
            },
          })
        }
        break
      }

      case 'gekto_tool_end':
        // Tool completion is visual-only — the next tool_start or text message provides context
        break

      case 'gekto_chat':
        if (msg.message) {
          const listener = (window as unknown as { __agentMessageListeners?: Map<string, (message: { id: string; text: string; sender: 'bot'; timestamp: Date }) => void> }).__agentMessageListeners?.get('master')
          if (listener) {
            listener({
              id: Date.now().toString(),
              text: msg.message,
              sender: 'bot',
              timestamp: new Date(),
            })
          }
        }
        break

      case 'gekto_delegate': {
        // Resolve agent display name from store (same logic as Lizard.tsx)
        const delegateAgentId = msg.agentId || ''
        const storeAgents = serverState.agents
        const delegateAgent = storeAgents[delegateAgentId]
        const delegateTask = delegateAgent?.taskId ? serverState.tasks[delegateAgent.taskId] : null
        const agentIds = Object.keys(storeAgents).filter(id => !id.startsWith('master_'))
        const agentIndex = agentIds.indexOf(delegateAgentId)
        const displayName = delegateTask?.name || `Agent ${agentIndex + 1}`

        const delegateListener = (window as unknown as { __agentMessageListeners?: Map<string, (message: { id: string; text: string; sender: string; timestamp: Date; systemType?: string; systemData?: Record<string, unknown> }) => void> }).__agentMessageListeners?.get('master')
        if (delegateListener) {
          delegateListener({
            id: Date.now().toString(),
            text: msg.message || '',
            sender: 'system',
            timestamp: new Date(),
            systemType: 'info',
            systemData: { type: 'delegate', agentName: displayName, agentId: delegateAgentId },
          })
        }
        break
      }

      case 'gekto_remove':
        if (msg.removedAgents && msg.removedAgents.length > 0) {
          for (const agentId of msg.removedAgents) {
            send({ type: 'delete_agent', agentId })
          }
          const listener = (window as unknown as { __agentMessageListeners?: Map<string, (message: { id: string; text: string; sender: 'bot'; timestamp: Date }) => void> }).__agentMessageListeners?.get('master')
          if (listener) {
            listener({
              id: Date.now().toString(),
              text: `Removed ${msg.removedAgents.length} agent${msg.removedAgents.length > 1 ? 's' : ''}: ${msg.removedAgents.join(', ')}`,
              sender: 'bot',
              timestamp: new Date(),
            })
          }
        }
        break

      case 'session_restored':
        if (msg.plan) {
          setIsPlanPanelOpen(true)
        }
        break

      case 'gekto_done': {
        // Finalize: stop streaming animations on master messages
        const doneListener = (window as unknown as { __agentMessageListeners?: Map<string, (message: { id: string; text: string; sender: 'bot'; timestamp: Date; isFinalize?: boolean }) => void> }).__agentMessageListeners?.get('master')
        if (doneListener) {
          doneListener({
            id: `gekto_finalize_${Date.now()}`,
            text: '',
            sender: 'bot',
            timestamp: new Date(),
            isFinalize: true,
          })
        }
        break
      }

      case 'plan_created':
        // Plan data arrives via plan_set action in useServerState — just open the panel
        // activePlanId already set by server when plan was created
        setIsCreatingNewPlan(false)
        setIsPlanPanelOpen(true)
        break

      case 'tasks_generated':
        // Tasks generated from abstract — plan panel will update automatically via server state
        // Plan status already set to prompts_ready by server
        break
    }
  }, [activePlans, send])

  // Handle task completion from worker agents
  const handleTaskComplete = useCallback((agentId: string, result: string, isError: boolean) => {
    // Notify server about task completion — server will update state
    const ws = getWebSocket()
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    // Find the task across all tasks (not just the selected plan)
    const allTasks = Object.values(serverState.tasks)
    const task = allTasks.find(t => t.assignedAgentId === agentId)
    if (!task) return

    const planId = task.planId
    if (!planId) return

    ws.send(JSON.stringify({
      type: isError ? 'task_failed' : 'task_completed',
      planId,
      taskId: task.id,
      result: isError ? undefined : result,
      error: isError ? result : undefined,
    }))

    // Dependent tasks become "ready" when all deps are done (pending_testing/completed).
    // Auto-run effect will pick them up and dispatch automatically.
  }, [getWebSocket, serverState.tasks])

  // Clean dispatched tracking when tasks leave 'pending' state (enables re-dispatch after retry)
  useEffect(() => {
    for (const taskId of dispatchedTaskIdsRef.current) {
      const task = serverState.tasks[taskId]
      if (task && task.status !== 'pending') {
        dispatchedTaskIdsRef.current.delete(taskId)
      }
    }
  }, [serverState.tasks])

  // Reset dispatched tracking when plan changes
  useEffect(() => {
    dispatchedTaskIdsRef.current.clear()
  }, [currentPlan?.id])

  // Auto-run available tasks when any plan is executing and new tasks become available
  useEffect(() => {
    // Run for the selected plan
    const plan = currentPlanRef.current
    if (!plan || plan.status !== 'executing') return
    runAvailableTasks()
  }, [planTasks, runAvailableTasks])

  // Expose handlers for AgentContext to call via window
  useEffect(() => {
    type PlanMessageHandler = (msg: {
      type: string
      plan?: ExecutionPlan
      planId?: string
      taskId?: string
      lizardId?: string
      status?: TaskStatus
      result?: string
      error?: string
    }) => void
    type TaskCompleteHandler = (agentId: string, result: string, isError: boolean) => void

    const windowWithHandlers = window as unknown as {
      __gektoMessageHandler?: PlanMessageHandler
      __gektoTaskComplete?: TaskCompleteHandler
    }
    windowWithHandlers.__gektoMessageHandler = handlePlanMessage
    windowWithHandlers.__gektoTaskComplete = handleTaskComplete

    return () => {
      windowWithHandlers.__gektoMessageHandler = undefined
      windowWithHandlers.__gektoTaskComplete = undefined
    }
  }, [handlePlanMessage, handleTaskComplete])

  const value = useMemo<GektoContextValue>(() => ({
    currentPlan,
    activePlans,
    selectedPlanId,
    isCreatingNewPlan,
    selectPlan,
    createNewPlan,
    config,
    directMode,
    setDirectMode,
    createPlan,
    generateTasks,
    executePlan,
    buildPlan,
    cancelPlan,
    getTaskStatus,
    getTaskByLizardId,
    markTaskResolved,
    retryTask,
    runTask,
    runAvailableTasks,
    removeTask,
    markTaskInProgress,
    delegatePrompt,
    isPlanPanelOpen,
    openPlanPanel,
    closePlanPanel,
  }), [
    currentPlan,
    activePlans,
    selectedPlanId,
    isCreatingNewPlan,
    selectPlan,
    createNewPlan,
    config,
    directMode,
    createPlan,
    generateTasks,
    executePlan,
    buildPlan,
    cancelPlan,
    getTaskStatus,
    getTaskByLizardId,
    markTaskResolved,
    retryTask,
    runTask,
    runAvailableTasks,
    removeTask,
    markTaskInProgress,
    delegatePrompt,
    isPlanPanelOpen,
    openPlanPanel,
    closePlanPanel,
  ])

  return (
    <GektoContext.Provider value={value}>
      {children}
    </GektoContext.Provider>
  )
}

export type { ExecutionPlan, Task, TaskStatus, PlanStatus, GektoConfig, GektoContextValue }

// Also export planTasks resolver for components that need resolved tasks
export function usePlanTasks(): Task[] {
  const { currentPlan } = useGekto()
  const { state } = useServerState()
  return useMemo(() => {
    if (!currentPlan) return []
    return (currentPlan.taskIds || [])
      .map((id: string) => state.tasks[id])
      .filter((t: Task | undefined): t is Task => !!t)
  }, [currentPlan, state.tasks])
}
