// EntityStore — per-entity file persistence in .gekto/ directory
//
// Provides directory-based storage so Gekto (the master agent) can query
// state using Read/Grep. The in-memory state remains server-authoritative;
// the file structure is a durable mirror.

import fs from 'fs'
import path from 'path'
import type { Task, ExecutionPlan, FileChange } from './agents/types.js'
import type { Agent, Persona, Plan, LizardVisual, GektoAppState } from './state.js'

// ============ Constants ============

const GEKTO_DIR = '.gekto'
const ENTITY_DIRS = ['plans', 'tasks', 'agents', 'file-changes'] as const

// Entity types that map to subdirectories
type EntityType = typeof ENTITY_DIRS[number]

// Top-level singleton files
type SingletonFile = 'overview' | 'settings' | 'personas' | 'visuals'

// ============ Path Helpers ============

let baseDir: string = ''

function getGektoDir(): string {
  return path.join(baseDir, GEKTO_DIR)
}

function getEntityDir(type: EntityType): string {
  return path.join(getGektoDir(), type)
}

function getEntityPath(type: EntityType, id: string): string {
  // Encode slashes in file paths for file-changes
  const safeId = id.replace(/\//g, '--')
  return path.join(getEntityDir(type), `${safeId}.json`)
}

function getSingletonPath(name: SingletonFile): string {
  return path.join(getGektoDir(), `${name}.json`)
}

// ============ Directory Management ============

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function ensureDirectoryStructure(): void {
  ensureDir(getGektoDir())
  for (const dir of ENTITY_DIRS) {
    ensureDir(getEntityDir(dir))
  }
}

// ============ File I/O ============

function writeJson(filePath: string, data: unknown): void {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8')
  } catch (err) {
    console.error(`[EntityStore] Failed to write ${filePath}:`, err)
  }
}

function readJson<T>(filePath: string): T | null {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8')
      return JSON.parse(raw) as T
    }
  } catch (err) {
    console.error(`[EntityStore] Failed to read ${filePath}:`, err)
  }
  return null
}

function deleteFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  } catch (err) {
    console.error(`[EntityStore] Failed to delete ${filePath}:`, err)
  }
}

// ============ Public API ============

/** Initialize the entity store. Creates .gekto/ directory if needed. */
export function initEntityStore(workingDir: string): void {
  baseDir = workingDir
  ensureDirectoryStructure()
}

/** Check if .gekto/ directory exists */
export function entityStoreExists(workingDir: string): boolean {
  return fs.existsSync(path.join(workingDir, GEKTO_DIR))
}

/** Persist a single entity to its file */
export function persistEntity(type: EntityType, id: string, data: unknown): void {
  writeJson(getEntityPath(type, id), data)
}

/** Delete a single entity file */
export function deleteEntity(type: EntityType, id: string): void {
  deleteFile(getEntityPath(type, id))
}

/** Persist a singleton file (overview, settings, personas, visuals) */
export function persistSingleton(name: SingletonFile, data: unknown): void {
  writeJson(getSingletonPath(name), data)
}

/** Read a singleton file */
export function readSingleton<T>(name: SingletonFile): T | null {
  return readJson<T>(getSingletonPath(name))
}

/** Load all entities of a given type from directory */
export function loadEntities<T>(type: EntityType): Record<string, T> {
  const dir = getEntityDir(type)
  const result: Record<string, T> = {}

  try {
    if (!fs.existsSync(dir)) return result

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    for (const file of files) {
      const filePath = path.join(dir, file)
      const data = readJson<T>(filePath)
      if (data && typeof data === 'object' && 'id' in (data as Record<string, unknown>)) {
        const id = (data as Record<string, unknown>).id as string
        result[id] = data
      }
    }
  } catch (err) {
    console.error(`[EntityStore] Failed to load ${type}:`, err)
  }

  return result
}

/** Load full state from .gekto/ directory */
export function loadFromEntityStore(workingDir: string): GektoAppState | null {
  if (!entityStoreExists(workingDir)) return null

  baseDir = workingDir

  try {
    // Load entities from subdirectories
    const tasks = loadEntities<Task>('tasks')
    const agents = loadEntities<Agent>('agents')
    const fileChanges = loadEntities<FileChange & { id: string }>('file-changes')

    // Load all non-completed plans into activePlans
    const planFiles = fs.readdirSync(getEntityDir('plans')).filter(f => f.endsWith('.json'))
    const activePlans: Record<string, ExecutionPlan> = {}
    for (const file of planFiles) {
      const p = readJson<ExecutionPlan>(path.join(getEntityDir('plans'), file))
      if (p && p.status !== 'completed' && p.status !== 'failed') {
        activePlans[p.id] = p
      }
    }

    // Load singletons
    const personas = readSingleton<Persona[]>('personas')
    const visuals = readSingleton<Record<string, LizardVisual>>('visuals')
    const settings = readSingleton<Record<string, unknown>>('settings')

    // Startup recovery: reset working agents, filter out soft-deleted
    const activeAgents: Record<string, Agent> = {}
    for (const [id, agent] of Object.entries(agents)) {
      if (agent.status === 'done') {
        // Soft-deleted agents stay on disk but don't load into memory
        continue
      }
      if (agent.status === 'working') {
        agent.status = 'error'
      }
      activeAgents[id] = agent
    }

    // Build fileChanges record from loaded entities (keyed by encoded path)
    const fileChangesRecord: Record<string, FileChange> = {}
    for (const [, fc] of Object.entries(fileChanges)) {
      const encodedPath = fc.filePath.replace(/\//g, '--')
      fileChangesRecord[encodedPath] = fc
    }

    // Resolve current master session ID
    const savedMasterId = (settings as Record<string, unknown> | null)?.currentMasterId as string | undefined
    let currentMasterId: string | null = null

    // If 'master' exists (legacy), migrate to a proper master_* ID
    if (activeAgents['master']) {
      const newId = `master_${Date.now()}`
      activeAgents[newId] = { ...activeAgents['master'], id: newId }
      delete activeAgents['master']
      currentMasterId = newId
      persistEntity('agents', newId, activeAgents[newId])
      deleteEntity('agents', 'master')
    } else if (savedMasterId && activeAgents[savedMasterId]) {
      // Saved setting points to a valid active agent
      currentMasterId = savedMasterId
    } else {
      // Find most recent active master_* agent
      const masterAgents = Object.values(activeAgents)
        .filter(a => a.id.startsWith('master_'))
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      if (masterAgents.length > 0) {
        currentMasterId = masterAgents[0].id
      }
    }

    // If no master session found, create a new one
    if (!currentMasterId) {
      currentMasterId = `master_${Date.now()}`
    }

    // Clean up: mark non-current master agents as done so they don't pollute memory
    for (const [id, agent] of Object.entries(activeAgents)) {
      if (id.startsWith('master_') && id !== currentMasterId) {
        // Mark as done on disk and remove from active set
        persistEntity('agents', id, {
          ...agent,
          status: 'done',
          completedAt: agent.completedAt || new Date().toISOString(),
        })
        delete activeAgents[id]
      }
    }

    // Persist so next restart doesn't need to re-detect
    if (currentMasterId !== savedMasterId) {
      const existingSettings = (settings as Record<string, unknown>) || {}
      persistSingleton('settings', { ...existingSettings, currentMasterId })
    }

    // Clean up orphaned tasks — only keep tasks referenced by active plans
    const activePlanTaskIds = new Set<string>()
    for (const plan of Object.values(activePlans)) {
      for (const taskId of plan.taskIds) {
        activePlanTaskIds.add(taskId)
      }
    }
    const activeTasks: Record<string, Task> = {}
    for (const [id, task] of Object.entries(tasks)) {
      if (activePlanTaskIds.has(id)) {
        activeTasks[id] = task
      } else {
        // Remove orphaned task file from disk
        deleteEntity('tasks', id)
      }
    }

    const state: GektoAppState = {
      activePlans,
      activePlanId: null,
      tasks: activeTasks,
      agents: activeAgents,
      visuals: visuals || {},
      chats: {},
      personas: personas || [
        { id: 'plain', name: 'Plain', systemPrompt: 'You are a helpful coding assistant.' },
        { id: 'architect', name: 'Architect', systemPrompt: 'You are a senior software architect. Focus on system design, patterns, and best practices.' },
        { id: 'codekeeper', name: 'Codekeeper', systemPrompt: 'You are a meticulous code reviewer. Focus on code quality, bugs, and improvements.' },
      ],
      plans: {},
      fileChanges: fileChangesRecord,
      currentMasterId,
    }

    return state
  } catch (err) {
    console.error('[EntityStore] Failed to load from .gekto/:', err)
    return null
  }
}

/** Persist a mutation to the appropriate entity file(s) */
export function persistMutation(mutationPath: string, value: unknown, state: GektoAppState): void {
  const parts = mutationPath.split('.')
  const topLevel = parts[0]

  switch (topLevel) {
    case 'tasks': {
      if (parts.length === 1) {
        // Bulk clear — delete all task files from disk
        const taskDir = getEntityDir('tasks')
        try {
          const files = fs.readdirSync(taskDir).filter(f => f.endsWith('.json'))
          for (const file of files) {
            deleteFile(path.join(taskDir, file))
          }
        } catch { /* ignore */ }
      } else if (parts.length >= 2) {
        const taskId = parts[1]
        if (value === undefined) {
          deleteEntity('tasks', taskId)
        } else if (parts.length === 2) {
          // Full task object
          persistEntity('tasks', taskId, value)
        } else {
          // Sub-property update — write full task
          const task = state.tasks[taskId]
          if (task) persistEntity('tasks', taskId, task)
        }
      }
      break
    }

    case 'agents': {
      if (parts.length >= 2) {
        const agentId = parts[1]
        if (value === undefined) {
          // Soft-delete: update file on disk with 'done' status (don't delete)
          const existing = readJson<Agent>(getEntityPath('agents', agentId))
          if (existing && existing.status !== 'done') {
            persistEntity('agents', agentId, {
              ...existing,
              status: 'done',
              completedAt: existing.completedAt || new Date().toISOString(),
            })
          }
        } else if (parts.length === 2) {
          persistEntity('agents', agentId, value)
        } else {
          const agent = state.agents[agentId]
          if (agent) persistEntity('agents', agentId, agent)
        }
      }
      break
    }

    case 'activePlans': {
      if (parts.length === 1) {
        // Full activePlans record replaced (e.g. cleared to {})
        if (!value || (typeof value === 'object' && Object.keys(value as Record<string, unknown>).length === 0)) {
          // Clear all plan files
          const planDir = getEntityDir('plans')
          try {
            const files = fs.readdirSync(planDir).filter(f => f.endsWith('.json'))
            for (const file of files) {
              deleteFile(path.join(planDir, file))
            }
          } catch { /* ignore */ }
        }
      } else if (parts.length >= 2) {
        const planId = parts[1]
        if (value === null || value === undefined) {
          // Specific plan removed
          deleteEntity('plans', planId)
        } else if (parts.length === 2) {
          // Full plan object — skip transient 'planning' status
          const plan = value as ExecutionPlan
          if (plan.status !== 'planning') {
            persistEntity('plans', plan.id, plan)
          }
        } else {
          // Sub-property update — write full plan from state
          const plan = state.activePlans[planId]
          if (plan) {
            persistEntity('plans', planId, plan)
          }
        }
      }
      break
    }

    case 'visuals': {
      persistSingleton('visuals', state.visuals)
      break
    }

    case 'personas': {
      persistSingleton('personas', state.personas)
      break
    }

    case 'chats': {
      // Chats are ephemeral for now — don't persist to .gekto/
      // Will move to agent messages in Phase 2
      break
    }

    case 'plans': {
      // Archive plans collection — skip for now
      break
    }

    case 'currentMasterId': {
      const existing = readSingleton<Record<string, unknown>>('settings') || {}
      persistSingleton('settings', { ...existing, currentMasterId: value })
      break
    }

    case 'fileChanges': {
      if (parts.length >= 2) {
        const changeId = parts[1]
        if (value === undefined) {
          deleteEntity('file-changes', changeId)
        } else {
          persistEntity('file-changes', changeId, value)
        }
      }
      break
    }
  }
}

/** Rebuild overview.json from current state */
export function rebuildOverview(state: GektoAppState): void {
  const overview: Record<string, unknown> = {
    currentMasterId: state.currentMasterId,
    agents: {} as Record<string, unknown>,
    tasks: {} as Record<string, unknown>,
    plans: {} as Record<string, unknown>,
    fileChanges: {} as Record<string, unknown>,
  }

  for (const [id, agent] of Object.entries(state.agents)) {
    // Skip archived master sessions — they're not visible on the whiteboard
    if (agent.status === 'done' && id.startsWith('master_')) continue
    (overview.agents as Record<string, unknown>)[id] = {
      status: agent.status,
      taskId: agent.taskId,
      planId: agent.planId,
      personaId: agent.personaId,
      createdAt: agent.createdAt,
      completedAt: agent.completedAt,
      fileChangeCount: agent.fileChanges?.length ?? 0,
    }
  }

  // Collect task IDs referenced by active plans
  const activePlanTaskIds = new Set<string>()
  for (const plan of Object.values(state.activePlans)) {
    for (const taskId of plan.taskIds) {
      activePlanTaskIds.add(taskId)
    }
  }

  for (const [id, task] of Object.entries(state.tasks)) {
    // Only include tasks that belong to an active plan
    if (!activePlanTaskIds.has(id)) continue
    const entry: Record<string, unknown> = {
      name: task.name,
      status: task.status,
      description: task.description,
      assignedAgentId: task.assignedAgentId,
      planId: task.planId,
      dependencies: task.dependencies,
      files: task.files,
    }
    if (task.error) entry.error = task.error
    if (task.result) { const r: string = task.result; entry.result = r.slice(0, 200) }  // truncate
    (overview.tasks as Record<string, unknown>)[id] = entry
  }

  for (const [planId, plan] of Object.entries(state.activePlans)) {
    (overview.plans as Record<string, unknown>)[planId] = {
      status: plan.status,
      title: plan.title,
      taskCount: plan.taskIds.length,
      taskIds: plan.taskIds,
      prompt: plan.originalPrompt,
      createdAt: plan.createdAt,
      completedAt: (plan as unknown as Record<string, unknown>).completedAt,
    }
  }

  // Show files that are planned or currently being worked on (not completed)
  const pendingFiles = overview.fileChanges as Record<string, unknown>
  for (const [, task] of Object.entries(state.tasks)) {
    if (!activePlanTaskIds.has(task.id)) continue
    if (task.status === 'completed' || task.status === 'failed') continue
    if (task.files) {
      for (const filePath of task.files) {
        pendingFiles[filePath] = {
          filePath,
          taskId: task.id,
          taskName: task.name,
          taskStatus: task.status,
          agentId: task.assignedAgentId || null,
        }
      }
    }
  }

  persistSingleton('overview', overview)
}

// ============ Settings ============

export interface GektoSettings {
  strategy: 'parallel-files' | 'sequential' | 'hybrid'
  defaultProvider: string
  maxParallelAgents: number
  autoSpawnWorkers: boolean
}

const DEFAULT_SETTINGS: GektoSettings = {
  strategy: 'parallel-files',
  defaultProvider: 'claude-code',
  maxParallelAgents: 5,
  autoSpawnWorkers: true,
}

export function loadSettings(): GektoSettings {
  const loaded = readSingleton<GektoSettings>('settings')
  return { ...DEFAULT_SETTINGS, ...loaded }
}

export function saveSettings(settings: GektoSettings): void {
  persistSingleton('settings', settings)
}

/** Persist full state to .gekto/ directory (used for initial migration) */
export function persistFullState(state: GektoAppState): void {
  ensureDirectoryStructure()

  // Tasks
  for (const [id, task] of Object.entries(state.tasks)) {
    persistEntity('tasks', id, task)
  }

  // Agents
  for (const [id, agent] of Object.entries(state.agents)) {
    persistEntity('agents', id, agent)
  }

  // Plans
  for (const [id, plan] of Object.entries(state.activePlans)) {
    persistEntity('plans', id, plan)
  }

  // File changes
  for (const [encodedPath, fc] of Object.entries(state.fileChanges)) {
    persistEntity('file-changes', encodedPath, fc)
  }

  // Singletons
  persistSingleton('visuals', state.visuals)
  persistSingleton('personas', state.personas)
  saveSettings(loadSettings())  // Ensure settings.json exists with defaults

  // Overview
  rebuildOverview(state)
}
