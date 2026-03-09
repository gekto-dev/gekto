// Server-authoritative state — THE single source of truth
//
// All durable state lives here. Widget receives a full snapshot on connect
// and incremental diffs on every mutation. Persisted to .gekto/ directory
// (per-entity files).

import type { WebSocket } from 'ws'
import type { FileChange, ExecutionPlan, Task, TaskStatus } from './agents/types.js'
import {
  initEntityStore,
  entityStoreExists,
  loadFromEntityStore,
  persistMutation,
  persistFullState,
  rebuildOverview,
} from './entityStore.js'

// Re-export for backward compatibility
export type { Task, TaskStatus } from './agents/types.js'

// ============ State Shape ============

export interface Message {
  id: string
  text: string
  sender: 'user' | 'bot' | 'system'
  timestamp: string // ISO string for serialization
  isTerminal?: boolean
  images?: string[]
  toolUse?: {
    tool: string
    input?: string
    fullInput?: Record<string, unknown>
    status: 'running' | 'completed'
    startTime: string
    endTime?: string
  }
  systemType?: 'mode' | 'status' | 'info'
  systemData?: Record<string, unknown>
  isStreaming?: boolean
}

export interface Persona {
  id: string
  name: string
  systemPrompt: string
  avatar?: string
}

// Task and TaskStatus imported from ./agents/types.js

export type AgentStatus = 'idle' | 'working' | 'done' | 'pending' | 'error'

export interface Agent {
  id: string
  taskId: string
  personaId: string
  status: AgentStatus
  fileChanges?: FileChange[]  // Deprecated — use fileChangePaths
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

export interface GektoAppState {
  plan: ExecutionPlan | null
  tasks: Record<string, Task>
  agents: Record<string, Agent>
  visuals: Record<string, LizardVisual>
  chats: Record<string, Message[]> // Deprecated — messages move to agents
  personas: Persona[]
  plans: Record<string, Plan>
  fileChanges: Record<string, FileChange>
  currentMasterId: string // ID of the active master chat session
}

// ============ Default Values ============

const DEFAULT_PERSONAS: Persona[] = [
  { id: 'plain', name: 'Plain', systemPrompt: 'You are a helpful coding assistant.' },
  { id: 'architect', name: 'Architect', systemPrompt: 'You are a senior software architect. Focus on system design, patterns, and best practices.' },
  { id: 'codekeeper', name: 'Codekeeper', systemPrompt: 'You are a meticulous code reviewer. Focus on code quality, bugs, and improvements.' },
]

function createMasterId(): string {
  return `master_${Date.now()}`
}

function createEmptyState(): GektoAppState {
  return {
    plan: null,
    tasks: {},
    agents: {},
    visuals: {},
    chats: {},
    personas: DEFAULT_PERSONAS,
    plans: {},
    fileChanges: {},
    currentMasterId: createMasterId(),
  }
}

// ============ In-Memory State ============

let state: GektoAppState = createEmptyState()

// Connected WebSocket clients for broadcasting actions
const connectedClients = new Set<WebSocket>()

// ============ Public API ============

/** Load state from disk or create empty. Call once at startup.
 *
 * Startup flow:
 * 1. .gekto/ exists → load from entity store
 * 2. Neither → create fresh .gekto/ with defaults
 */
export function initState(): void {
  const workingDir = process.cwd()

  // Try loading from .gekto/ directory
  if (entityStoreExists(workingDir)) {
    console.log('[State] Loading from .gekto/ directory')
    const loaded = loadFromEntityStore(workingDir)
    if (loaded) {
      state = loaded
      initEntityStore(workingDir)
      rebuildOverview(state)
      return
    }
  }

  // Fresh start
  console.log('[State] Creating fresh .gekto/ directory')
  state = createEmptyState()
  initEntityStore(workingDir)
  persistFullState(state)
}

/** Return a readonly reference to current state. */
export function getState(): GektoAppState {
  return state
}

/**
 * Apply a mutation to state and persist to entity store.
 * Does NOT broadcast — caller must use broadcast helpers explicitly.
 *
 * @param dotPath  Dot-separated path into state (e.g. "tasks.task_1.status")
 * @param value The new value to set at that path
 */
export function mutate(dotPath: string, value: unknown): void {
  setNestedValue(state as unknown as Record<string, unknown>, dotPath, value)
  persistMutation(dotPath, value, state)
  // Keep overview.json in sync for agent/plan/task changes
  if (dotPath.startsWith('agents.') || dotPath.startsWith('plan') || dotPath.startsWith('tasks.')) {
    rebuildOverview(state)
  }
}

/**
 * Apply multiple mutations atomically — deduplicates entity file writes.
 * Does NOT broadcast — caller must use broadcast helpers explicitly.
 */
export function mutateBatch(mutations: Array<{ path: string; value: unknown }>): void {
  for (const { path, value } of mutations) {
    setNestedValue(state as unknown as Record<string, unknown>, path, value)
  }

  // Deduplicate entity writes: multiple mutations to same entity = one write
  const entityKeys = new Set<string>()
  for (const { path, value } of mutations) {
    const key = path.split('.').slice(0, 2).join('.')
    if (!entityKeys.has(key)) {
      entityKeys.add(key)
      persistMutation(path, value, state)
    } else {
      // Already persisted the entity — persist again with latest state
      persistMutation(path, value, state)
    }
  }

  // Keep overview.json in sync
  if (mutations.some(m => m.path.startsWith('agents.') || m.path.startsWith('plan') || m.path.startsWith('tasks.'))) {
    rebuildOverview(state)
  }
}

/** Register a WebSocket client for receiving diffs. */
export function addClient(ws: WebSocket): void {
  connectedClients.add(ws)
}

/** Unregister a WebSocket client. */
export function removeClient(ws: WebSocket): void {
  connectedClients.delete(ws)
}

/** Send full state snapshot to a single client. */
export function sendSnapshot(ws: WebSocket): void {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({
      type: 'state_snapshot',
      state,
    }))
  }
}

/** Get set of connected clients (for broadcasts outside of mutate). */
export function getClients(): Set<WebSocket> {
  return connectedClients
}

// ============ Typed Broadcast Helpers ============

/** Send a typed action message to all connected clients. */
export function broadcast(action: Record<string, unknown>): void {
  const msg = JSON.stringify(action)
  for (const client of connectedClients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(msg)
    }
  }
}

/** Broadcast the full plan object to all clients. */
export function broadcastPlan(): void {
  broadcast({ type: 'plan_set', plan: state.plan })
}

/** Broadcast a single task (full object) to all clients. */
export function broadcastTask(taskId: string): void {
  const task = state.tasks[taskId]
  if (task) {
    broadcast({ type: 'task_set', taskId, task })
  } else {
    broadcast({ type: 'task_delete', taskId })
  }
}

/** Broadcast a single agent (full object) to all clients. */
export function broadcastAgent(agentId: string): void {
  const agent = state.agents[agentId]
  if (agent) {
    broadcast({ type: 'agent_set', agentId, agent })
  } else {
    broadcast({ type: 'agent_delete', agentId })
  }
}

/** Broadcast the full visuals map to all clients. */
export function broadcastVisuals(): void {
  broadcast({ type: 'visuals_set', visuals: state.visuals })
}

/** Broadcast removal of a single visual. */
export function broadcastVisualDelete(agentId: string): void {
  broadcast({ type: 'visual_delete', agentId })
}

/** Broadcast a file change to all clients. */
export function broadcastFileChange(path: string): void {
  const change = state.fileChanges[path]
  if (change) {
    broadcast({ type: 'file_change_set', path, change })
  }
}

/** Broadcast a chat for a specific agent to all clients. */
export function broadcastChat(agentId: string): void {
  const messages = state.chats[agentId]
  if (messages) {
    broadcast({ type: 'chat_set', agentId, messages })
  }
}

/**
 * Auto-broadcast based on a dot-path. Used by generic mutation endpoints
 * (like save_state) where the caller doesn't know the entity type.
 */
export function broadcastForPath(dotPath: string): void {
  const parts = dotPath.split('.')
  const root = parts[0]

  switch (root) {
    case 'plan':
      broadcastPlan()
      break
    case 'tasks':
      if (parts[1]) broadcastTask(parts[1])
      break
    case 'agents':
      if (parts[1]) broadcastAgent(parts[1])
      break
    case 'visuals':
      if (parts.length === 1) {
        broadcastVisuals()
      } else if (parts[1]) {
        // Single visual updated or deleted
        if (state.visuals[parts[1]]) {
          broadcastVisuals()
        } else {
          broadcastVisualDelete(parts[1])
        }
      }
      break
    case 'fileChanges':
      if (parts[1]) broadcastFileChange(parts[1])
      break
    case 'chats':
      if (parts[1]) broadcastChat(parts[1])
      break
  }
}

// ============ Helpers ============

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.')
  let current = obj as Record<string, unknown>
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]
    if (current[key] === undefined || current[key] === null || typeof current[key] !== 'object') {
      current[key] = {}
    }
    current = current[key] as Record<string, unknown>
  }
  const lastKey = keys[keys.length - 1]
  if (value === undefined) {
    delete current[lastKey]
  } else {
    current[lastKey] = value
  }
}
