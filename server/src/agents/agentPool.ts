import path from 'path'
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'
import { WebSocket } from 'ws'
import type { AgentProvider, StreamCallbacks, AgentResponse, FileChange } from './types.js'
import { HeadlessAgent } from './HeadlessAgent.js'
import { getState, mutate, broadcastFileChange, broadcastAgent } from '../state.js'
import { BASH_SAFETY_RULES } from './bashSafetyRules.js'

interface QueuedMessage {
  message: string
  ws: WebSocket
  callbacks: StreamCallbacks
  resolve: (response: AgentResponse) => void
  reject: (error: Error) => void
  imagePaths?: string[]
}

interface LizardSession {
  agent: AgentProvider
  isProcessing: boolean
  queue: QueuedMessage[]
  currentWs: WebSocket | null  // Track current WebSocket for delivering responses
}

// Per-lizard sessions
const sessions = new Map<string, LizardSession>()

// Summarize tool input for display
function summarizeInput(input: Record<string, unknown>): string {
  if (input.file_path) return String(input.file_path)
  if (input.pattern) return String(input.pattern)
  if (input.command) return String(input.command).substring(0, 50)
  if (input.path) return String(input.path)
  return ''
}

const DEFAULT_SYSTEM_PROMPT = `You are a helpful coding assistant. Be concise and direct in your responses.

You can use Bash for running tests, installing packages, building, and other shell operations.
${BASH_SAFETY_RULES}

Your job is to:
- Read and understand code using Read, Glob, Grep tools
- Write and edit code using Write and Edit tools
- Use Bash for running tests, installing packages, git operations, and build commands
- Make the requested code changes

STATUS MARKER - At the END of EVERY response, you MUST include exactly one of these markers:
- [STATUS:DONE] - Use when the task is complete and you have no questions for the user
- [STATUS:PENDING] - Use when you need user input, confirmation, clarification, or approval to proceed

Examples:
- After completing a code change: "I've updated the function. [STATUS:DONE]"
- When asking a question: "Which approach would you prefer? [STATUS:PENDING]"
- After answering a simple question: "The file is located at src/utils.ts [STATUS:DONE]"`

// Tools that agents are not allowed to use
const DISALLOWED_TOOLS = ['Task']

function getOrCreateSession(lizardId: string, ws?: WebSocket): LizardSession {
  let session = sessions.get(lizardId)
  if (!session) {
    session = {
      agent: new HeadlessAgent({
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        workingDir: getWorkingDir(),
        disallowedTools: DISALLOWED_TOOLS,
      }),
      isProcessing: false,
      queue: [],
      currentWs: ws ?? null,
    }
    sessions.set(lizardId, session)
  } else if (ws) {
    // Update WebSocket reference for existing session
    session.currentWs = ws
  }
  return session
}

export function resumeSession(lizardId: string, sessionId?: string, ws?: WebSocket): LizardSession {
  let session = sessions.get(lizardId)
  if (!session) {
    const agent = new HeadlessAgent({
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      workingDir: getWorkingDir(),
      disallowedTools: DISALLOWED_TOOLS,
    })
    // Restore Claude Code session ID so --resume works
    if (sessionId) {
      agent.setSessionId(sessionId)
    }
    session = {
      agent,
      isProcessing: false,
      queue: [],
      currentWs: ws ?? null,
    }
    sessions.set(lizardId, session)
  } else if (ws) {
    session.currentWs = ws
  }
  return session
}

export function isProcessing(lizardId: string): boolean {
  const session = sessions.get(lizardId)
  return session?.isProcessing ?? false
}

export function getQueueLength(lizardId: string): number {
  const session = sessions.get(lizardId)
  return session?.queue.length ?? 0
}

// Helper to safely send to current WebSocket
function safeSend(session: LizardSession, data: Record<string, unknown>) {
  const ws = session.currentWs
  if (ws && ws.readyState === ws.OPEN) {
    const type = data.type as string
    const lizardId = data.lizardId as string | undefined
    // Log outgoing messages (skip noisy streaming deltas)
    if (type !== 'text' && type !== 'thinking') {
      console.log(`[WS→] ${type}${lizardId ? ` [${lizardId}]` : ''}${data.tool ? ` tool=${data.tool}` : ''}${data.state ? ` state=${data.state}` : ''}`)
    }
    ws.send(JSON.stringify(data))
  }
}

// Save base64 data URL images to temp files and return file paths
export function saveImagesToTempFiles(images: string[]): string[] {
  const paths: string[] = []
  const dir = path.join(tmpdir(), 'gekto-images')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  for (const dataUrl of images) {
    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/)
    if (!match) continue
    const ext = match[1] === 'jpeg' ? 'jpg' : match[1]
    const buffer = Buffer.from(match[2], 'base64')
    const filePath = path.join(dir, `gekto-img-${randomUUID()}.${ext}`)
    writeFileSync(filePath, buffer)
    paths.push(filePath)
  }
  return paths
}

export async function sendMessage(
  lizardId: string,
  message: string,
  ws: WebSocket,
  images?: string[]
): Promise<AgentResponse> {
  const session = getOrCreateSession(lizardId, ws)

  // Save images to temp files and build the final message
  let finalMessage = message
  let imagePaths: string[] | undefined
  if (images && images.length > 0) {
    imagePaths = saveImagesToTempFiles(images)
  }

  // Accumulators for streaming deltas — reset on each tool start
  let accumulatedText = ''
  let accumulatedThinking = ''

  // Create streaming callbacks that use session's current WebSocket
  const callbacks: StreamCallbacks = {
    onToolStart: (tool: string, input?: Record<string, unknown>) => {
      // Reset accumulators when a new tool starts (text block ended)
      accumulatedText = ''
      accumulatedThinking = ''
      safeSend(session, {
        type: 'tool',
        lizardId,
        status: 'running',
        tool,
        input: input ? summarizeInput(input) : undefined,
        fullInput: input,  // Send full input for expandable view
      })
    },
    onToolEnd: (tool: string) => {
      safeSend(session, {
        type: 'tool',
        lizardId,
        status: 'completed',
        tool,
      })
    },
    onText: (text: string) => {
      accumulatedText += text
      safeSend(session, {
        type: 'text',
        lizardId,
        text: accumulatedText,
      })
    },
    onThinking: (text: string) => {
      accumulatedThinking += text
      safeSend(session, {
        type: 'thinking',
        lizardId,
        text: accumulatedThinking,
      })
    },
    onToolResult: (tool: string, content: string, toolUseId: string) => {
      safeSend(session, {
        type: 'tool_result',
        lizardId,
        tool,
        content: content.length > 2000 ? content.substring(0, 2000) + '…' : content,
        toolUseId,
      })
    },
    onFileChange: (change: FileChange) => {
      // Encode path for use as key
      const encodedPath = change.filePath.replace(/\//g, '--')

      // Enrich change with metadata
      const enrichedChange: FileChange = {
        ...change,
        agentId: lizardId,
        taskId: getState().agents[lizardId]?.taskId,
        timestamp: new Date().toISOString(),
      }

      // Write to top-level fileChanges collection
      mutate(`fileChanges.${encodedPath}`, enrichedChange)
      broadcastFileChange(encodedPath)

      // Also update agent's fileChangePaths for reference
      const agent = getState().agents[lizardId]
      if (agent) {
        const paths = agent.fileChangePaths ?? []
        if (!paths.includes(change.filePath)) {
          mutate(`agents.${lizardId}.fileChangePaths`, [...paths, change.filePath])
        }

        // Keep backward-compat fileChanges on agent
        const existing = agent.fileChanges ?? []
        const existingIndex = existing.findIndex(fc => fc.filePath === change.filePath)
        let updated: FileChange[]
        if (existingIndex >= 0) {
          updated = [...existing]
          updated[existingIndex] = { ...updated[existingIndex], after: change.after, tool: change.tool }
        } else {
          updated = [...existing, enrichedChange]
        }
        mutate(`agents.${lizardId}.fileChanges`, updated)
        broadcastAgent(lizardId)
      }

      safeSend(session, {
        type: 'file_change',
        lizardId,
        change: enrichedChange,
      })
    },
  }

  // If already processing, queue the message
  if (session.isProcessing) {
    return new Promise((resolve, reject) => {
      session.queue.push({ message: finalMessage, ws, callbacks, resolve, reject, imagePaths })
      const position = session.queue.length
      ws.send(JSON.stringify({
        type: 'queued',
        lizardId,
        position,
      }))
    })
  }

  // Process immediately
  return processMessage(lizardId, session, finalMessage, ws, callbacks, imagePaths)
}

async function processMessage(
  lizardId: string,
  session: LizardSession,
  message: string,
  _ws: WebSocket,  // Kept for queue compatibility, but we use session.currentWs
  callbacks: StreamCallbacks,
  imagePaths?: string[]
): Promise<AgentResponse> {
  session.isProcessing = true
  safeSend(session, { type: 'state', lizardId, state: 'working' })

  try {
    const response = await session.agent.send(message, callbacks, imagePaths)

    safeSend(session, {
      type: 'response',
      lizardId,
      text: response.result,
      sessionId: response.session_id,
      cost: response.total_cost_usd,
      duration: response.duration_ms,
    })

    return response
  } catch (err) {
    safeSend(session, {
      type: 'error',
      lizardId,
      message: String(err),
    })
    throw err
  } finally {
    session.isProcessing = false
    safeSend(session, { type: 'state', lizardId, state: 'ready' })

    // Process next queued message if any
    if (session.queue.length > 0) {
      const next = session.queue.shift()!
      processMessage(lizardId, session, next.message, next.ws, next.callbacks, next.imagePaths)
        .then(next.resolve)
        .catch(next.reject)
    }
  }
}

export function resetSession(lizardId: string): void {
  const session = sessions.get(lizardId)
  if (session) {
    session.agent.resetSession()
    session.queue = []
  }
}

export function deleteSession(lizardId: string): void {
  sessions.delete(lizardId)
}

export function getWorkingDir(): string {
  // In dev mode (GEKTO_DEV=1), use test-app as the working directory
  if (process.env.GEKTO_DEV === '1') {
    return path.resolve(process.cwd(), '../test-app')
  }
  return process.cwd()
}

// Update WebSocket for all sessions (called when new client connects)
export function attachWebSocket(ws: WebSocket): void {
  for (const session of sessions.values()) {
    session.currentWs = ws
  }
}

export interface ActiveSession {
  lizardId: string
  isProcessing: boolean
  isRunning: boolean
  queueLength: number
  // Full state for sync
  state: 'ready' | 'working' | 'queued'
  queuePosition: number
}

export function getActiveSessions(): ActiveSession[] {
  const result: ActiveSession[] = []
  for (const [lizardId, session] of sessions) {
    // Determine state
    let state: 'ready' | 'working' | 'queued' = 'ready'
    let queuePosition = 0

    if (session.isProcessing) {
      state = 'working'
    } else if (session.queue.length > 0) {
      state = 'queued'
      queuePosition = session.queue.length
    }

    result.push({
      lizardId,
      isProcessing: session.isProcessing,
      isRunning: session.agent.isRunning(),
      queueLength: session.queue.length,
      state,
      queuePosition,
    })
  }
  return result
}

export function killSession(lizardId: string): boolean {
  const session = sessions.get(lizardId)
  if (session) {
    const killed = session.agent.kill()
    session.isProcessing = false
    session.queue = []
    // Remove from map so getActiveSessions() doesn't return dead agents
    sessions.delete(lizardId)
    return killed
  }
  return false
}

// Revert files to their pre-agent state using the before content from FileChange objects
export function revertFiles(
  filePaths: string[],
  fileChanges: FileChange[]
): { reverted: string[], failed: string[] } {
  const reverted: string[] = []
  const failed: string[] = []
  const workingDir = getWorkingDir()

  for (const filePath of filePaths) {
    const change = fileChanges.find(fc => fc.filePath === filePath)
    if (!change) {
      failed.push(filePath)
      continue
    }

    try {
      const fullPath = filePath.startsWith('/')
        ? filePath
        : path.resolve(workingDir, filePath)

      if (change.before === null) {
        // File was newly created by agent — delete it
        if (existsSync(fullPath)) {
          unlinkSync(fullPath)
        }
      } else {
        // File existed before — restore original content
        const dir = dirname(fullPath)
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true })
        }
        writeFileSync(fullPath, change.before, 'utf-8')
      }
      reverted.push(filePath)
    } catch (err) {
      console.error(`[AgentPool] Failed to revert ${filePath}:`, err)
      failed.push(filePath)
    }
  }

  return { reverted, failed }
}

export function killAllSessions(): number {
  let count = 0
  for (const [, session] of sessions) {
    if (session.agent.kill()) {
      count++
    }
    session.isProcessing = false
    session.queue = []
  }
  // Clear all sessions so getActiveSessions() returns empty
  sessions.clear()
  return count
}
