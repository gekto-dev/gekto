import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { CLAUDE_PATH } from '../claudePath.js'

// Gekto persistent process - warm Claude process for structured planning and chat
// Plan mode is the default, direct mode is enabled via UI toggle

export type GektoMode = 'direct' | 'plan'
export type GektoState = 'loading' | 'ready' | 'error'

export interface GektoCallbacks {
  onStateChange?: (state: GektoState) => void
  onToolStart?: (tool: string, input?: Record<string, unknown>) => void
  onToolEnd?: (tool: string) => void
  onText?: (text: string) => void
  onThinking?: (text: string) => void
  onResult?: (text: string) => void
  onError?: (error: string) => void
}

// === JSON Schema for structured output ===

export const GEKTO_OUTPUT_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['create_plan', 'reply', 'clarify', 'remove_agents', 'update_plan'],
    },
    message: { type: 'string' },
    abstract: { type: 'string' },
    buildPrompt: { type: 'string' },
    target: { type: 'string' },
  },
  required: ['action'],
})

// === System Prompt (PM personality) ===

const GEKTO_SYSTEM_PROMPT = `You are Gekto, a sharp, opinionated project manager AI. You own the product and the codebase.

How you think:
- You understand the full stack — frontend, backend, infra, tooling.
- You break ambiguous asks into concrete, parallel tasks.
- You push back on bad ideas. You suggest better alternatives.
- You know when something is a 5-minute fix vs. a 3-day refactor.

How you act:
- Every response MUST be a structured JSON action. Never output free text outside of the action schema.
- If the user greets you or asks a question, use "reply" with your answer in "message".
- If the user's request is ambiguous, use "clarify" with a focused question in "message".
- If the user wants to build something, use "create_plan" with an abstract plan description.
- If the user wants to modify an existing plan abstract, use "update_plan" with the updated abstract.
- If the user wants to remove agents, use "remove_agents" with a target.
- ALWAYS research the codebase first (Read, Glob, Grep) before creating plans. Understand the project structure, frameworks, and conventions.

Abstract plan rules for create_plan / update_plan:
- The "abstract" field is a clear, scannable text document (markdown) describing what will be done.
- Start with a 1-2 sentence summary of the goal as a markdown blockquote (> prefix).
- Then list the work items as numbered sections. Each section should have:
  - A short bold title on its own line, followed by a blank line
  - 1-3 sentences describing what will be done, as a separate paragraph after the title
  - List of specific files to create/modify (as bullet points with paths)
- IMPORTANT: Always put a blank line between the bold title and the description text. They must be separate paragraphs in the markdown.
- The text must be easy for the user to scan fast and understand the overall plan.
- Focus on WHAT will be done, not HOW (implementation details come later in task prompts).
- Mention specific file paths so the user can verify scope.
- Include a "buildPrompt" explaining how to wire everything together after individual tasks complete.
- Work items should be parallelizable — no item should depend on another item's output.

You can ONLY use Read, Glob, and Grep tools. Bash and Task are disabled.

Your response MUST be valid JSON matching this schema. Output ONLY the JSON object, nothing else.
${GEKTO_OUTPUT_SCHEMA}`

let opusProcess: ChildProcessWithoutNullStreams | null = null
let opusReady = false
let opusLoading = false
let opusPendingResolve: ((result: string) => void) | null = null
let opusBuffer = ''
let opusCallbacks: GektoCallbacks | null = null
let opusCurrentTool: string | null = null
let opusReceivedDeltas = false

// Session ID for persistent history - generated once and shared across all Gekto calls
// This allows both direct mode (persistent process) and plan mode (one-shot calls) to share history
let gektoSessionId: string = randomUUID()
let sessionConflictRetries = 0
const MAX_SESSION_RETRIES = 3

// Conversation history to replay when starting a fresh session (e.g. after session lock conflict)
let pendingHistoryReplay: string | null = null
let historyReplayed = false

let workingDir = process.cwd()
let stateChangeCallback: ((state: GektoState) => void) | null = null

// === Initialization ===

export interface StoredMessage {
  text: string
  sender: 'user' | 'bot' | 'system'
}

export function initGekto(
  cwd: string,
  onStateChange?: (state: GektoState) => void,
  sessionId?: string,
  messages?: StoredMessage[],
): void {
  workingDir = cwd
  stateChangeCallback = onStateChange || null

  // Restore previous session if available
  if (sessionId) {
    gektoSessionId = sessionId
  }

  // Store conversation history for replay if session can't be resumed
  if (messages && messages.length > 0) {
    pendingHistoryReplay = formatHistoryForReplay(messages)
  }
  historyReplayed = false

  // Start Opus process
  spawnOpus()
}

function formatHistoryForReplay(messages: StoredMessage[]): string {
  // Only include user and bot messages, skip system/tool messages
  const relevant = messages.filter(m => m.sender === 'user' || m.sender === 'bot')
  if (relevant.length === 0) return ''

  const lines = relevant.map(m => {
    const role = m.sender === 'user' ? 'User' : 'You (Gekto)'
    return `${role}: ${m.text}`
  })

  return `[CONVERSATION HISTORY — this is our previous conversation, continue from where we left off]\n\n${lines.join('\n\n')}\n\n[END OF HISTORY — respond normally to the next message]`
}

export function getGektoState(): GektoState {
  if (opusLoading) return 'loading'
  if (opusReady) return 'ready'
  return 'loading'
}

// === Opus Process ===

function spawnOpus(): void {
  if (opusProcess) return

  opusLoading = true
  opusReady = false
  updateState()

  const args = [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', 'claude-opus-4-5-20251101',
    '--system-prompt', GEKTO_SYSTEM_PROMPT,
    '--dangerously-skip-permissions',
    '--disallowed-tools', 'Bash', 'Task',
    '--session-id', gektoSessionId,
  ]

  console.log(`[GektoPersistent] Spawning with session ${gektoSessionId}`)

  let sessionConflict = false

  opusProcess = spawn(CLAUDE_PATH, args, {
    cwd: workingDir,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // Prevent EPIPE crash when writing to stdin of a dead process
  opusProcess.stdin.on('error', () => {})

  opusProcess.on('error', (err) => {
    console.error(`[GektoPersistent] Spawn error:`, err)
  })

  opusProcess.stdout.on('data', (data) => {
    opusBuffer += data.toString()
    const lines = opusBuffer.split('\n')
    opusBuffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line)
        handleOpusEvent(event)
      } catch {
        // Ignore non-JSON lines
      }
    }
  })

  opusProcess.stderr.on('data', (data) => {
    const text = data.toString().trim()
    console.error(`[GektoPersistent] stderr:`, text)
    if (text.includes('already in use')) {
      sessionConflict = true
    }
  })

  opusProcess.on('close', (code) => {
    console.error(`[GektoPersistent] Process exited with code ${code}`)
    opusProcess = null
    opusReady = false
    opusLoading = true
    updateState()

    if (opusPendingResolve) {
      opusPendingResolve('Process restarting, please try again.')
      opusPendingResolve = null
    }

    // If session ID was rejected, retry same ID (lock may be stale from old process)
    if (sessionConflict) {
      sessionConflictRetries++
      if (sessionConflictRetries <= MAX_SESSION_RETRIES) {
        console.error(`[GektoPersistent] Session ID conflict, retrying same session in ${sessionConflictRetries * 2}s (${sessionConflictRetries}/${MAX_SESSION_RETRIES})`)
        setTimeout(spawnOpus, sessionConflictRetries * 2000)
        return
      }
      // All retries exhausted — start fresh
      console.error(`[GektoPersistent] Session lock not released after ${MAX_SESSION_RETRIES} retries, starting new session`)
      gektoSessionId = randomUUID()
      sessionConflictRetries = 0
      setTimeout(spawnOpus, 100)
      return
    }

    // Successful start — reset conflict counter
    sessionConflictRetries = 0

    // Auto-restart
    setTimeout(spawnOpus, 1000)
  })

  opusProcess.on('error', () => {
    opusProcess = null
    opusReady = false
    opusLoading = true
    updateState()
  })

  // Process is warm once spawned — no need to send a message
  opusReady = true
  opusLoading = false
  updateState()
}

function handleOpusEvent(event: Record<string, unknown>): void {
  // Result event means process is working
  if (event.type === 'result') {
    if (!opusReady) {
      opusReady = true
      opusLoading = false
      updateState()
    }
  }

  // Tool use detection + thinking from assistant message
  if (event.type === 'assistant' && event.message) {
    const message = event.message as { content?: Array<{ type: string; name?: string; thinking?: string; input?: Record<string, unknown> }> }
    if (message.content) {
      for (const block of message.content) {
        if (block.type === 'tool_use' && block.name) {
          opusCurrentTool = block.name
          opusCallbacks?.onToolStart?.(block.name, block.input)
        }
        if (block.type === 'thinking' && block.thinking && !opusReceivedDeltas) {
          opusCallbacks?.onThinking?.(block.thinking)
        }
      }
    }
  }

  // Tool result (tool completed)
  if (event.type === 'user' && event.message) {
    const message = event.message as { content?: Array<{ type: string }> }
    if (message.content) {
      for (const block of message.content) {
        if (block.type === 'tool_result' && opusCurrentTool) {
          opusCallbacks?.onToolEnd?.(opusCurrentTool)
          opusCurrentTool = null
        }
      }
    }
  }

  // Text streaming (text_delta = response text, thinking_delta = extended thinking)
  if (event.type === 'content_block_delta') {
    const delta = event.delta as { type?: string; text?: string; thinking?: string } | undefined
    if (delta?.type === 'text_delta' && delta.text) {
      opusReceivedDeltas = true
      opusCallbacks?.onText?.(delta.text)
    } else if (delta?.type === 'thinking_delta' && delta.thinking) {
      opusReceivedDeltas = true
      opusCallbacks?.onThinking?.(delta.thinking)
    }
  }

  // Final result — resolve on ANY result event, even if result is empty
  if (event.type === 'result') {
    if (opusPendingResolve) {
      opusPendingResolve((event.result as string) || '')
      opusPendingResolve = null
    }
  }
}

async function sendToOpus(prompt: string, callbacks: GektoCallbacks, retries = 3): Promise<string> {
  // Ensure process is running, respawn if needed
  if (!opusProcess) {
    spawnOpus()
    await new Promise(resolve => setTimeout(resolve, 500))
  }

  if (!opusProcess) {
    if (retries > 0) {
      console.error(`[GektoPersistent] Process not available, retrying... (${retries} left)`)
      await new Promise(resolve => setTimeout(resolve, 1000))
      return sendToOpus(prompt, callbacks, retries - 1)
    }
    throw new Error('Gekto process failed to start after retries')
  }

  // Inject conversation history on first message if session couldn't be resumed
  let actualPrompt = prompt
  if (pendingHistoryReplay && !historyReplayed) {
    actualPrompt = `${pendingHistoryReplay}\n\n${prompt}`
    historyReplayed = true
    pendingHistoryReplay = null
    console.log(`[GektoPersistent] Injected conversation history into first message`)
  }

  opusCallbacks = callbacks
  opusCurrentTool = null
  opusReceivedDeltas = false

  return new Promise((resolve) => {
    opusPendingResolve = (result: string) => {
      opusCallbacks = null
      resolve(result)
    }

    const inputMessage = {
      type: 'user',
      message: { role: 'user', content: actualPrompt },
    }
    if (opusProcess && !opusProcess.killed && opusProcess.stdin.writable) {
      opusProcess.stdin.write(JSON.stringify(inputMessage) + '\n')
    } else {
      // Process died between check and write — retry
      opusPendingResolve = null
      opusCallbacks = null
      if (retries > 0) {
        console.error(`[GektoPersistent] Process died before write, retrying... (${retries} left)`)
        resolve(sendToOpus(prompt, callbacks, retries - 1))
      } else {
        resolve('')
      }
      return
    }

    // Timeout after 5 min for complex tasks
    setTimeout(() => {
      if (opusPendingResolve) {
        opusPendingResolve('Task timed out. Please try breaking it into smaller steps.')
        opusPendingResolve = null
      }
    }, 300000)
  })
}

// === Planning API (reuses warm persistent process) ===

export async function sendPlanningPrompt(
  prompt: string,
  callbacks?: GektoCallbacks,
): Promise<string> {
  return sendToOpus(prompt, callbacks || {})
}

// === Main API ===

export interface GektoResponse {
  mode: GektoMode
  message: string
  workMs?: number
}

// Mode is now passed as parameter - default is 'plan', UI can toggle to 'direct'
export async function sendToGekto(
  prompt: string,
  mode: GektoMode = 'plan',
  callbacks?: GektoCallbacks
): Promise<GektoResponse> {
  const startTime = Date.now()

  // Plan mode - return immediately, caller will use gektoTools.ts for planning
  if (mode === 'plan') {
    return {
      mode: 'plan',
      message: 'Creating plan...',
    }
  }

  // Direct mode - use Opus
  const result = await sendToOpus(prompt, callbacks || {})
  const workMs = Date.now() - startTime

  callbacks?.onResult?.(result)

  return {
    mode: 'direct',
    message: result,
    workMs,
  }
}

// === State Management ===

function updateState(): void {
  const state = getGektoState()
  stateChangeCallback?.(state)
}

export function isGektoReady(): boolean {
  return opusReady
}

// Set/update state change callback (for reconnections)
export function setStateCallback(callback: (state: GektoState) => void): void {
  stateChangeCallback = callback
}

// Get current session ID (shared between direct and plan modes)
export function getGektoSessionId(): string {
  return gektoSessionId
}

// Reset session to start fresh (clears history)
export function resetGektoSession(): void {
  gektoSessionId = randomUUID()
  // Kill current process to force restart with new session
  if (opusProcess) {
    opusProcess.kill('SIGTERM')
  }
}

// Restore a previous session by switching to its session ID
export function restoreGektoSession(sessionId: string): void {
  gektoSessionId = sessionId
  // Kill current process to force restart with the restored session ID
  if (opusProcess) {
    opusProcess.kill('SIGTERM')
  }
}

// === Abort current task (like pressing ESC in CLI) ===

export function abortGekto(messages?: StoredMessage[]): boolean {
  let aborted = false

  // Send SIGINT to interrupt current Opus task (like Ctrl+C / ESC)
  if (opusProcess && opusPendingResolve) {
    opusProcess.kill('SIGINT')
    // Resolve the pending promise so caller doesn't hang
    opusPendingResolve('Task was stopped.')
    opusPendingResolve = null
    opusCallbacks = null
    opusCurrentTool = null
    aborted = true

    // Set up history replay so restarted process has conversation context
    // (SIGINT may not save the interrupted turn to the session)
    if (messages && messages.length > 0) {
      pendingHistoryReplay = formatHistoryForReplay(messages)
      historyReplayed = false
    }
  }

  return aborted
}
