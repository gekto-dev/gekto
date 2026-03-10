// Gekto Store — thin wrapper over server-authoritative state
//
// Provides the same useStore(selector) API as before, but reads from
// server state (via useServerState's external store) and dispatches
// actions as WebSocket messages. No Zustand, no localStorage.

import { useSyncExternalStore } from 'react'
import {
  getServerState,
  subscribeToServerState,
  type GektoAppState,
  type Message,
  type Task,
  type Agent,
  type FileChange,
  type Persona,
  type Plan,
  type AgentStatus,
  type TaskStatus,
  type PlanStatus,
} from '../hooks/useServerState'

export type {
  Message,
  Task,
  Agent,
  FileChange,
  Persona,
  Plan,
  AgentStatus,
  TaskStatus,
  PlanStatus,
}

export interface ToolMessage {
  tool: string
  input?: string
  fullInput?: Record<string, unknown>
  status: 'running' | 'completed'
  startTime: Date
  endTime?: Date
}

// ============ Actions (send WS messages) ============

function sendWs(msg: Record<string, unknown>): void {
  const ws = (window as unknown as { __gektoWebSocket?: WebSocket }).__gektoWebSocket
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

// ============ Store Interface (compatible with old useStore API) ============

interface GektoActions {
  // Tasks
  createTask: (task: Task) => Task
  updateTask: (id: string, updates: Partial<Task>) => void
  deleteTask: (id: string) => void
  addMessageToTask: (taskId: string, message: Message) => void

  // Agents
  createAgent: (agent: Agent) => void
  updateAgent: (id: string, updates: Partial<Agent>) => void
  deleteAgent: (id: string) => void
  clearAllAgents: () => void
  addFileChange: (agentId: string, change: FileChange) => void
  removeFileChanges: (agentId: string, filePaths: string[]) => void

  // Plans
  createPlan: (plan: Omit<Plan, 'createdAt'> & { createdAt?: Date }) => Plan
  updatePlan: (id: string, updates: Partial<Plan>) => void
  deletePlan: (id: string) => void
  addTaskToPlan: (planId: string, taskId: string) => void
  removeTaskFromPlan: (planId: string, taskId: string) => void

  // Personas
  createPersona: (persona: Persona) => void
  updatePersona: (id: string, updates: Partial<Persona>) => void
  deletePersona: (id: string) => void

  // Bulk
  reset: () => void

}

type GektoStore = GektoAppState & GektoActions

// Build the full store object from server state + actions
function buildStore(): GektoStore {
  const state = getServerState()

  return {
    ...state,

    // Tasks
    createTask: (task) => {
      const newTask: Task = {
        id: task.id,
        name: task.name,
        description: task.description,
        prompt: task.prompt,
        status: task.status,
        planId: task.planId,
        files: task.files,
        assignedAgentId: task.assignedAgentId,
        dependencies: task.dependencies,
        result: task.result,
        error: task.error,
        sessionId: task.sessionId,
      }
      sendWs({ type: 'save_state', path: `tasks.${task.id}`, value: newTask })
      return newTask
    },
    updateTask: (id, updates) => {
      sendWs({ type: 'save_state', path: `tasks.${id}`, value: { ...state.tasks[id], ...updates } })
    },
    deleteTask: (id) => {
      sendWs({ type: 'save_state', path: `tasks.${id}`, value: undefined })
    },
    addMessageToTask: (taskId, message) => {
      // Save message via WS
      const existing = state.chats[taskId] || []
      const serialized: Message = {
        ...message,
        timestamp: typeof message.timestamp === 'string' ? message.timestamp : new Date().toISOString(),
      }
      sendWs({ type: 'save_chat', agentId: taskId, messages: [...existing, serialized] })
    },

    // Agents
    createAgent: (agent) => {
      sendWs({ type: 'save_state', path: `agents.${agent.id}`, value: agent })
    },
    updateAgent: (id, updates) => {
      const existing = state.agents[id]
      if (existing) {
        sendWs({ type: 'save_state', path: `agents.${id}`, value: { ...existing, ...updates } })
      }
    },
    deleteAgent: (id) => {
      sendWs({ type: 'delete_agent', agentId: id })
    },
    clearAllAgents: () => {
      sendWs({ type: 'clear_all_agents' })
    },
    addFileChange: (agentId, change) => {
      const agent = state.agents[agentId]
      if (!agent) return
      const existing = agent.fileChanges ?? []
      const existingIndex = existing.findIndex(fc => fc.filePath === change.filePath)
      let updated: FileChange[]
      if (existingIndex >= 0) {
        updated = [...existing]
        updated[existingIndex] = { ...updated[existingIndex], after: change.after, tool: change.tool }
      } else {
        updated = [...existing, change]
      }
      sendWs({ type: 'save_state', path: `agents.${agentId}.fileChanges`, value: updated })
    },
    removeFileChanges: (agentId, filePaths) => {
      const agent = state.agents[agentId]
      if (!agent) return
      const revertedSet = new Set(filePaths)
      const updated = (agent.fileChanges ?? []).filter(fc => !revertedSet.has(fc.filePath))
      sendWs({ type: 'save_state', path: `agents.${agentId}.fileChanges`, value: updated })
    },

    // Plans
    createPlan: (plan) => {
      const newPlan: Plan = {
        ...plan,
        createdAt: plan.createdAt ? (plan.createdAt instanceof Date ? plan.createdAt.toISOString() : plan.createdAt as string) : new Date().toISOString(),
      }
      sendWs({ type: 'save_state', path: `plans.${plan.id}`, value: newPlan })
      return newPlan
    },
    updatePlan: (id, updates) => {
      const existing = state.plans[id]
      if (existing) {
        sendWs({ type: 'save_state', path: `plans.${id}`, value: { ...existing, ...updates } })
      }
    },
    deletePlan: (id) => {
      sendWs({ type: 'save_state', path: `plans.${id}`, value: undefined })
    },
    addTaskToPlan: (planId, taskId) => {
      const plan = state.plans[planId]
      if (plan && !plan.taskIds.includes(taskId)) {
        sendWs({ type: 'save_state', path: `plans.${planId}.taskIds`, value: [...plan.taskIds, taskId] })
      }
    },
    removeTaskFromPlan: (planId, taskId) => {
      const plan = state.plans[planId]
      if (plan) {
        sendWs({ type: 'save_state', path: `plans.${planId}.taskIds`, value: plan.taskIds.filter(id => id !== taskId) })
      }
    },

    // Personas
    createPersona: (persona) => {
      sendWs({ type: 'save_state', path: 'personas', value: [...state.personas, persona] })
    },
    updatePersona: (id, updates) => {
      const updated = state.personas.map(p => p.id === id ? { ...p, ...updates } : p)
      sendWs({ type: 'save_state', path: 'personas', value: updated })
    },
    deletePersona: (id) => {
      sendWs({ type: 'save_state', path: 'personas', value: state.personas.filter(p => p.id !== id) })
    },

    // Bulk
    reset: () => {
      sendWs({ type: 'save_state', path: 'tasks', value: {} })
      sendWs({ type: 'save_state', path: 'agents', value: {} })
      sendWs({ type: 'save_state', path: 'plans', value: {} })
      sendWs({ type: 'save_state', path: 'chats', value: {} })
    },
  }
}

// ============ useStore Hook ============

// Cache for selector stability
let cachedStore: GektoStore | null = null
let cachedStateRef: GektoAppState | null = null

function getStore(): GektoStore {
  const currentState = getServerState()
  // Only rebuild if server state reference changed
  if (currentState !== cachedStateRef) {
    cachedStateRef = currentState
    cachedStore = buildStore()
  }
  return cachedStore!
}

export function useStore<T>(selector: (state: GektoStore) => T): T {
  return useSyncExternalStore(
    subscribeToServerState,
    () => selector(getStore()),
    () => selector(getStore()),
  )
}

// Static getState() for use outside React (e.g., in AgentContext WS handlers)
useStore.getState = (): GektoStore => {
  return getStore()
}

// ============ Selectors (unchanged) ============

export const selectTasks = (state: GektoStore) => state.tasks
export const selectTask = (id: string) => (state: GektoStore) => state.tasks[id]
export const selectAgents = (state: GektoStore) => state.agents
export const selectAgent = (id: string) => (state: GektoStore) => state.agents[id]
export const selectPlans = (state: GektoStore) => state.plans
export const selectPlan = (id: string) => (state: GektoStore) => state.plans[id]
export const selectPersonas = (state: GektoStore) => state.personas

export const selectAgentByTaskId = (taskId: string) => (state: GektoStore) =>
  Object.values(state.agents).find((a) => a.taskId === taskId)
