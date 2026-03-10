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

    // Load plan — pick the most recent active plan from plans/ dir
    const planFiles = fs.readdirSync(getEntityDir('plans')).filter(f => f.endsWith('.json'))
    let plan: ExecutionPlan | null = null
    const allPlans: ExecutionPlan[] = []
    for (const file of planFiles) {
      const p = readJson<ExecutionPlan>(path.join(getEntityDir('plans'), file))
      if (p) allPlans.push(p)
    }
    // Prefer active plans (draft/executing/ready/generating_prompts), then most recent by ID
    const activePlan = allPlans.find(p =>
      p.status === 'draft' || p.status === 'executing' || p.status === 'ready' || p.status === 'generating_prompts' || p.status === 'prompts_ready'
    )
    plan = activePlan || allPlans.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null

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

    // Persist so next restart doesn't need to re-detect
    if (currentMasterId !== savedMasterId) {
      const existingSettings = (settings as Record<string, unknown>) || {}
      persistSingleton('settings', { ...existingSettings, currentMasterId })
    }

    const state: GektoAppState = {
      plan,
      tasks,
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
      if (parts.length >= 2) {
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
          // Don't delete agent files — soft-deleted agents keep their history on disk
        } else if (parts.length === 2) {
          persistEntity('agents', agentId, value)
        } else {
          const agent = state.agents[agentId]
          if (agent) persistEntity('agents', agentId, agent)
        }
      }
      break
    }

    case 'plan': {
      if (value === null || value === undefined) {
        // Plan removed — delete all plan files
        const planDir = getEntityDir('plans')
        try {
          const files = fs.readdirSync(planDir).filter(f => f.endsWith('.json'))
          for (const file of files) {
            deleteFile(path.join(planDir, file))
          }
        } catch { /* ignore */ }
      } else if (parts.length === 1) {
        // Full plan object — skip transient 'planning' status (not a real plan yet)
        const plan = value as ExecutionPlan
        if (plan.status !== 'planning') {
          persistEntity('plans', plan.id, plan)
        }
      } else {
        // Sub-property update — write full plan
        if (state.plan) {
          persistEntity('plans', state.plan.id, state.plan)
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
    agents: {} as Record<string, unknown>,
    tasks: {} as Record<string, unknown>,
    plans: {} as Record<string, unknown>,
  }

  for (const [id, agent] of Object.entries(state.agents)) {
    (overview.agents as Record<string, unknown>)[id] = {
      status: agent.status,
      taskId: agent.taskId,
    }
  }

  for (const [id, task] of Object.entries(state.tasks)) {
    (overview.tasks as Record<string, unknown>)[id] = {
      name: task.name,
      status: task.status,
      assignedAgentId: task.assignedAgentId,
    }
  }

  if (state.plan) {
    (overview.plans as Record<string, unknown>)[state.plan.id] = {
      status: state.plan.status,
      taskCount: state.plan.taskIds.length,
      prompt: state.plan.originalPrompt,
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

  // Plan
  if (state.plan) {
    persistEntity('plans', state.plan.id, state.plan)
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
