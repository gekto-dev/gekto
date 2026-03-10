// useServerState — single hook that mirrors server-authoritative state
//
// On connect: receives full state_snapshot
// On mutation: receives typed action messages (plan_set, task_set, agent_set, etc.)
// Components read from `state`, send actions via `send()`

import { useState, useEffect, useCallback, useSyncExternalStore } from 'react'

// ============ Types (mirror server/src/state.ts) ============

export interface Message {
  id: string
  text: string
  sender: 'user' | 'bot' | 'system'
  timestamp: Date | string
  isTerminal?: boolean
  images?: string[]
  toolUse?: {
    tool: string
    input?: string
    fullInput?: Record<string, unknown>
    status: 'running' | 'completed'
    startTime: Date | string
    endTime?: Date | string
  }
  systemType?: 'mode' | 'status' | 'info'
  systemData?: Record<string, unknown>
  isStreaming?: boolean
  isThinking?: boolean
  isFinalize?: boolean
  toolResult?: {
    tool: string
    content: string
    toolUseId: string
  }
  cost?: number
  duration?: number
}

export interface Persona {
  id: string
  name: string
  systemPrompt: string
  avatar?: string
}

export type TaskStatus = 'pending' | 'in_progress' | 'pending_testing' | 'completed' | 'failed'

export interface Task {
  id: string
  name: string
  description: string
  prompt: string
  status: TaskStatus
  planId?: string
  files?: string[]
  assignedAgentId?: string
  dependencies?: string[]
  result?: string
  error?: string
  sessionId?: string
}

export type AgentStatus = 'idle' | 'working' | 'done' | 'pending' | 'error'

export interface FileChange {
  tool: 'Write' | 'Edit'
  filePath: string
  before: string | null
  after: string
  agentId?: string
  taskId?: string
  timestamp?: string
}

export interface Agent {
  id: string
  taskId: string
  personaId: string
  status: AgentStatus
  fileChanges?: FileChange[]
  fileChangePaths?: string[]
  messages?: Message[]
  sessionId?: string
  planId?: string
  createdAt?: string
  completedAt?: string
}

export type PlanStatus = 'executing' | 'completed' | 'failed' | 'canceled'

export interface Plan {
  id: string
  name: string
  status: PlanStatus
  taskIds: string[]
  originalPrompt?: string
  createdAt: string
  completedAt?: string
}

export interface LizardVisual {
  position: { x: number; y: number }
  color: string
}

export type ExecutionPlanStatus = 'planning' | 'ready' | 'generating_prompts' | 'prompts_ready' | 'executing' | 'completed' | 'failed'

export interface ExecutionPlan {
  id: string
  status: ExecutionPlanStatus
  originalPrompt: string
  reasoning?: string
  buildPrompt?: string
  taskIds: string[]
  createdAt: string
  completedAt?: string
}

export interface GektoAppState {
  plan: ExecutionPlan | null
  tasks: Record<string, Task>
  agents: Record<string, Agent>
  visuals: Record<string, LizardVisual>
  chats: Record<string, Message[]>
  personas: Persona[]
  plans: Record<string, Plan>
  fileChanges: Record<string, FileChange>
  currentMasterId: string
}

// ============ State Store (external store for useSyncExternalStore) ============

type Listener = () => void

let currentState: GektoAppState = {
  plan: null,
  tasks: {},
  agents: {},
  visuals: {},
  chats: {},
  personas: [],
  plans: {},
  fileChanges: {},
  currentMasterId: '',
}

const listeners = new Set<Listener>()

function getSnapshot(): GektoAppState {
  return currentState
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emitChange(): void {
  for (const listener of listeners) {
    listener()
  }
}

function setState(newState: GektoAppState): void {
  currentState = newState
  emitChange()
}

function updateState(updater: (s: GektoAppState) => GektoAppState): void {
  currentState = updater(currentState)
  emitChange()
}

// ============ Singleton WebSocket Connection ============

let wsInstance: WebSocket | null = null
let wsConnected = false
let snapshotReceived = false
const connectionListeners = new Set<Listener>()

function initWebSocket(): void {
  if (wsInstance) return // Already initialized

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(`${protocol}//${window.location.host}/__gekto/agent`)
  wsInstance = ws

  // Expose globally for backward compat
  ;(window as unknown as { __gektoWebSocket?: WebSocket }).__gektoWebSocket = ws

  ws.onopen = () => {
    wsConnected = true
    for (const l of connectionListeners) l()
    // Request agent list on connect
    ws.send(JSON.stringify({ type: 'list_agents' }))
  }

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data)
      switch (msg.type) {
        case 'state_snapshot':
          snapshotReceived = true
          setState(msg.state)
          break

        case 'plan_set':
          updateState(s => ({ ...s, plan: msg.plan }))
          break

        case 'task_set':
          updateState(s => ({ ...s, tasks: { ...s.tasks, [msg.taskId]: msg.task } }))
          break

        case 'task_delete':
          updateState(s => {
            const t = { ...s.tasks }
            delete t[msg.taskId]
            return { ...s, tasks: t }
          })
          break

        case 'agent_set':
          updateState(s => ({ ...s, agents: { ...s.agents, [msg.agentId]: msg.agent } }))
          break

        case 'agent_delete':
          updateState(s => {
            const a = { ...s.agents }
            delete a[msg.agentId]
            return { ...s, agents: a }
          })
          break

        case 'current_master_changed':
          updateState(s => ({ ...s, currentMasterId: msg.currentMasterId }))
          break

        case 'visuals_set':
          updateState(s => ({ ...s, visuals: msg.visuals }))
          break

        case 'visual_delete':
          updateState(s => {
            const v = { ...s.visuals }
            delete v[msg.agentId]
            return { ...s, visuals: v }
          })
          break

        case 'file_change_set':
          updateState(s => ({ ...s, fileChanges: { ...s.fileChanges, [msg.path]: msg.change } }))
          break

        case 'chat_set':
          updateState(s => ({ ...s, chats: { ...s.chats, [msg.agentId]: msg.messages } }))
          break

        default:
          // Forward streaming/transient messages to rawMessageHandler
          if (rawMessageHandler) {
            rawMessageHandler(msg)
          }
          break
      }
    } catch (err) {
      console.error('[useServerState] Failed to parse message:', err)
    }
  }

  ws.onclose = () => {
    wsConnected = false
    wsInstance = null
    ;(window as unknown as { __gektoWebSocket?: WebSocket }).__gektoWebSocket = undefined
    for (const l of connectionListeners) l()
  }

  ws.onerror = (error) => {
    console.error('[useServerState] WebSocket error:', error)
  }
}

// ============ Hook ============

export interface UseServerStateReturn {
  state: GektoAppState
  send: (action: Record<string, unknown>) => void
  isConnected: boolean
  isReady: boolean
  ws: WebSocket | null
}

export function useServerState(): UseServerStateReturn {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [isConnected, setIsConnected] = useState(wsConnected)

  // Initialize WS connection once
  useEffect(() => {
    initWebSocket()

    const listener = () => setIsConnected(wsConnected)
    connectionListeners.add(listener)
    // Sync current state
    setIsConnected(wsConnected)

    return () => {
      connectionListeners.delete(listener)
    }
  }, [])

  const send = useCallback((action: Record<string, unknown>) => {
    if (wsInstance && wsInstance.readyState === WebSocket.OPEN) {
      wsInstance.send(JSON.stringify(action))
    }
  }, [])

  return {
    state,
    send,
    isConnected,
    isReady: snapshotReceived,
    ws: wsInstance,
  }
}

// ============ Raw Message Handler ============

let rawMessageHandler: ((msg: Record<string, unknown>) => void) | null = null

export function setRawMessageHandler(handler: ((msg: Record<string, unknown>) => void) | null): void {
  rawMessageHandler = handler
}

// ============ Direct state access (for use outside React) ============

export function getServerState(): GektoAppState {
  return currentState
}

export function subscribeToServerState(listener: Listener): () => void {
  return subscribe(listener)
}

/**
 * Update agent messages in client-side state directly (no server round-trip).
 * Used by ChatWindow to keep master agent messages in sync so that
 * unmount/remount cycles don't load stale snapshot data.
 */
export function updateLocalAgentMessages(agentId: string, messages: Message[]): void {
  const agent = currentState.agents[agentId]
  if (agent) {
    currentState = {
      ...currentState,
      agents: {
        ...currentState.agents,
        [agentId]: { ...agent, messages },
      },
    }
  } else {
    currentState = {
      ...currentState,
      agents: {
        ...currentState.agents,
        [agentId]: {
          id: agentId,
          taskId: '',
          personaId: 'plain',
          status: 'idle' as AgentStatus,
          messages,
          createdAt: new Date().toISOString(),
        },
      },
    }
  }
  emitChange()
}
