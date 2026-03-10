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
  // Current plan (from server state)
  currentPlan: ExecutionPlan | null

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

  // Server state — plan comes from here
  const { state: serverState, send } = useServerState()
  const currentPlan = serverState.plan

  // Resolve tasks from plan.taskIds + state.tasks
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

    // If there's already a plan in draft or ready state, we're modifying it
    const isModifyingPlan = currentPlan?.status === 'draft' || currentPlan?.status === 'ready'
    const planId = isModifyingPlan ? currentPlan.id : `plan_test_${Date.now()}`

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
      existingPlan: isModifyingPlan ? {
        abstract: currentPlan.abstract,
      } : undefined,
    }
    if (images && images.length > 0) {
      payload.images = images
    }
    ws.send(JSON.stringify(payload))
  }, [getWebSocket, storeAgents, directMode, currentPlan])

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

  // Execute the current plan
  const executePlan = useCallback(async () => {
    const plan = currentPlanRef.current
    const tasks = planTasksRef.current
    if (!plan) return
    if (plan.status !== 'prompts_ready') return

    const ws = getWebSocket()
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    // Update plan status to executing
    send({ type: 'save_state', path: 'plan.status', value: 'executing' })

    // Notify server that execution started
    ws.send(JSON.stringify({
      type: 'execute_plan',
      planId: plan.id,
    }))

    // Find tasks that can run
    const completedTaskIds = new Set(
      tasks.filter(t => t.status === 'completed').map(t => t.id)
    )

    const tasksToRun = tasks.filter(task => {
      if (task.status !== 'pending') return false
      return task.dependencies.every(depId => completedTaskIds.has(depId))
    })

    // Create agents and tasks in store for each task to run
    const taskAssignments: { taskId: string; agentId: string; prompt: string }[] = []
    for (const task of tasksToRun) {
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
    send({ type: 'save_state', path: 'plan.taskIds', value: updatedTaskIds })
    send({ type: 'save_state', path: 'plan.status', value: 'executing' })

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

    send({ type: 'save_state', path: 'plan', value: null })
    setIsPlanPanelOpen(false)
  }, [currentPlan, getWebSocket, send])

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

    send({
      type: 'mark_task_resolved',
      taskId,
      agentId,
    })
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
    if (currentPlan.status === 'ready') {
      send({ type: 'save_state', path: 'plan.status', value: 'executing' })
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
    mode?: string
    text?: string
    timing?: { classifyMs?: number; workMs?: number }
  }) => {
    switch (msg.type) {
      case 'planning_started':
        // Set temporary planning state — panel will open when plan_created arrives
        // Don't overwrite existing draft plans being modified
        if (!currentPlan || currentPlan.status === 'completed' || currentPlan.status === 'failed') {
          send({
            type: 'save_state',
            path: 'plan',
            value: {
              id: msg.planId,
              status: 'planning',
              originalPrompt: msg.prompt ?? '',
              taskIds: [],
              createdAt: new Date().toISOString(),
            },
          })
        } else if (currentPlan.status === 'draft') {
          // Keep existing plan data, just mark as planning
          send({ type: 'save_state', path: 'plan.status', value: 'planning' })
        }
        break

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
        setIsPlanPanelOpen(true)
        break

      case 'tasks_generated':
        // Tasks generated from abstract — plan panel will update automatically via server state
        // Plan status already set to prompts_ready by server
        break
    }
  }, [currentPlan, send])

  // Handle task completion from worker agents
  const handleTaskComplete = useCallback((agentId: string, result: string, isError: boolean) => {
    // Notify server about task completion — server will update state
    const ws = getWebSocket()
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    const plan = currentPlanRef.current
    const tasks = planTasksRef.current
    if (!plan) return

    const task = tasks.find(t => t.assignedAgentId === agentId)
    if (!task) return

    ws.send(JSON.stringify({
      type: isError ? 'task_failed' : 'task_completed',
      planId: plan.id,
      taskId: task.id,
      result: isError ? undefined : result,
      error: isError ? result : undefined,
    }))

    // Check if there are more tasks to run (with satisfied dependencies)
    if (!isError) {
      const updatedTasks = tasks.map(t =>
        t.id === task.id
          ? { ...t, status: (isError ? 'failed' : 'pending_testing') as TaskStatus }
          : t
      )

      const completedTaskIds = new Set(
        updatedTasks.filter(t => t.status === 'completed').map(t => t.id)
      )

      const nextTasks = updatedTasks.filter(t => {
        if (t.status !== 'pending') return false
        return t.dependencies.every(depId => completedTaskIds.has(depId))
      })

      for (const nextTask of nextTasks) {
        const nextAgentId = `worker_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

        send({
          type: 'create_task_and_agent',
          task: {
            id: nextTask.id,
            name: nextTask.description.slice(0, 50),
            description: nextTask.description,
            prompt: nextTask.prompt,
            status: 'in_progress',
            planId: plan.id,
            files: nextTask.files,
            assignedAgentId: nextAgentId,
            dependencies: nextTask.dependencies,
          },
          agent: {
            id: nextAgentId,
            taskId: nextTask.id,
            personaId: 'plain',
            status: 'working',
          },
        })

        setTimeout(() => {
          sendMessage(nextAgentId, nextTask.prompt)
        }, 100)
      }
    }
  }, [getWebSocket, sendMessage, send])

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
    removeTask,
    markTaskInProgress,
    delegatePrompt,
    isPlanPanelOpen,
    openPlanPanel,
    closePlanPanel,
  }), [
    currentPlan,
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

export type { ExecutionPlan, Task, TaskStatus, PlanStatus, GektoConfig }

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
