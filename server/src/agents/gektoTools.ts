import { spawn } from 'child_process'
import { CLAUDE_PATH } from '../claudePath.js'
import { sendPlanningPrompt, type GektoCallbacks } from './gektoPersistent.js'
import type { Task, ExecutionPlan, GektoToolResult } from './types.js'

// Re-export types for backward compatibility
export type { Task, ExecutionPlan, GektoToolResult } from './types.js'

// System prompt for generating structured tasks from a plan abstract
const TASK_GEN_SYSTEM = `You are a senior engineer breaking a plan abstract into concrete coding tasks.
Given a plan abstract and project context, output a JSON array of tasks.

Each task object must have:
- "name": short title (under 6 words)
- "description": what this task does (1-2 sentences)
- "files": array of specific file paths to create/modify
- "prompt": detailed agent prompt (100-300 words) telling the agent:
  - Specific files to create/modify
  - Implementation approach
  - Edge cases to handle
  - What "done" looks like
  - MUST include: "Do NOT import from files created by other tasks"

Rules:
- 3-7 tasks, ALL run in parallel (no dependencies between them)
- Tasks must not overlap on files
- No "research" or "scaffold" tasks
- Each task must be self-contained

Output ONLY a valid JSON array of task objects, nothing else. No markdown wrapping.`

// === Callbacks for streaming events ===

export interface PlanCallbacks {
  onToolStart?: (tool: string, input?: Record<string, unknown>) => void
  onToolEnd?: (tool: string) => void
  onText?: (text: string) => void
  onThinking?: (text: string) => void
}

// Existing plan context for modifications
interface ExistingPlanContext {
  abstract?: string
  tasks?: { id: string; description: string; prompt: string; files: string[]; dependencies: string[] }[]
  reasoning?: string
}

// === Structured output parsing ===

interface GektoStructuredOutput {
  action: 'create_plan' | 'reply' | 'clarify' | 'remove_agents' | 'update_plan'
  message?: string
  abstract?: string
  buildPrompt?: string
  target?: string
}

function parseGektoOutput(raw: string): GektoStructuredOutput | null {
  // Try direct parse first (ideal case: pure JSON output)
  try {
    return JSON.parse(raw)
  } catch {
    // noop
  }

  // Strip markdown fences and retry
  const stripped = raw.trim().replace(/```json\s*/g, '').replace(/```\s*/g, '')
  try {
    return JSON.parse(stripped)
  } catch {
    // noop
  }

  // Gekto sometimes outputs text before/after the JSON (e.g. "Let me create the plan:\n{...}")
  // Extract the first top-level JSON object from the output
  const firstBrace = raw.indexOf('{')
  if (firstBrace >= 0) {
    // Find the matching closing brace by counting depth
    let depth = 0
    let inString = false
    let escape = false
    for (let i = firstBrace; i < raw.length; i++) {
      const ch = raw[i]
      if (escape) {
        escape = false
        continue
      }
      if (ch === '\\' && inString) {
        escape = true
        continue
      }
      if (ch === '"') {
        inString = !inString
        continue
      }
      if (inString) continue
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          const jsonStr = raw.slice(firstBrace, i + 1)
          try {
            return JSON.parse(jsonStr)
          } catch {
            break
          }
        }
      }
    }
  }

  console.error('[Gekto] Failed to parse structured output')
  console.error('[Gekto] Raw output (first 500 chars):', raw.slice(0, 500))
  return null
}

// === Main Processing Function ===

export async function processWithTools(
  prompt: string,
  planId: string,
  _workingDir: string,
  activeAgents: { lizardId: string; isProcessing: boolean; queueLength: number }[] = [],
  callbacks?: PlanCallbacks,
  existingPlan?: ExistingPlanContext,
  imagePaths?: string[],
): Promise<GektoToolResult> {
  // Build context prompt with active agents and existing plan
  let contextPrompt = prompt

  // Add agent context
  if (activeAgents.length > 0) {
    contextPrompt += `\n\n[Context: Active agents: ${activeAgents.map(a => a.lizardId).join(', ')}]`
  }

  // Add existing plan context for modifications
  if (existingPlan?.abstract) {
    contextPrompt += `\n\n[EXISTING PLAN ABSTRACT - User wants to modify this plan:

${existingPlan.abstract}

The user's message above is a modification request. Respond with "update_plan" and the FULL updated abstract (not just the changes). Keep the same structure and style.]`
  }

  // Append image file paths to prompt so Gekto can reference them
  if (imagePaths && imagePaths.length > 0) {
    const imageRefs = imagePaths.map(p => `  - ${p}`).join('\n')
    contextPrompt += `\n\n[The user attached ${imagePaths.length} image(s). Use the Read tool to view them:\n${imageRefs}]`
  }

  // Send to persistent process (system prompt + --json-schema already configured there)
  const planCallbacks: GektoCallbacks = {
    onToolStart: callbacks?.onToolStart ? (tool, input) => callbacks.onToolStart!(tool, input) : undefined,
    onToolEnd: callbacks?.onToolEnd ? (tool) => callbacks.onToolEnd!(tool) : undefined,
    onText: callbacks?.onText ? (text) => callbacks.onText!(text) : undefined,
    onThinking: callbacks?.onThinking ? (text) => callbacks.onThinking!(text) : undefined,
  }

  const resultJson = await sendPlanningPrompt(contextPrompt, planCallbacks)

  // Parse structured JSON output (guaranteed valid by --json-schema)
  const parsed = parseGektoOutput(resultJson)
  if (!parsed) {
    // Fallback: treat unparseable output as a chat reply
    return { type: 'chat', message: resultJson.trim() || "I'm here to help! What would you like me to work on?" }
  }

  switch (parsed.action) {
    case 'create_plan':
    case 'update_plan': {
      // Create a draft plan with abstract — tasks are generated later
      const plan: ExecutionPlan = {
        id: planId,
        status: 'draft',
        originalPrompt: prompt,
        abstract: parsed.abstract || parsed.message || '',
        buildPrompt: parsed.buildPrompt,
        taskIds: [],
        createdAt: new Date().toISOString(),
      }
      return {
        type: 'build',
        plan,
        tasks: [],
        message: parsed.message || parsed.abstract?.split('\n')[0] || 'Plan created.',
      }
    }

    case 'reply':
    case 'clarify':
      return {
        type: 'chat',
        message: parsed.message || 'Hello!',
      }

    case 'remove_agents':
      return {
        type: 'remove',
        removedAgents: resolveRemoveTarget(parsed.target || 'all', activeAgents),
      }

    default:
      return { type: 'chat', message: parsed.message || "I'm not sure how to help with that." }
  }
}

// === Helper Functions ===

function resolveRemoveTarget(
  target: string | string[],
  activeAgents: { lizardId: string; isWorker?: boolean }[]
): string[] {
  if (Array.isArray(target)) {
    // Specific agent IDs
    return target
  }

  switch (target) {
    case 'all':
      // All agents (including regular lizards, but not master)
      return activeAgents.filter(a => a.lizardId !== 'master').map(a => a.lizardId)
    case 'workers':
      // Only worker agents (by flag or by ID prefix)
      return activeAgents.filter(a =>
        a.isWorker || a.lizardId.startsWith('worker_')
      ).map(a => a.lizardId)
    case 'completed':
      // This would need status info - for now return workers
      return activeAgents.filter(a =>
        a.isWorker || a.lizardId.startsWith('worker_')
      ).map(a => a.lizardId)
    default:
      return []
  }
}

// === JSON Array Parser (robust) ===

function parseJsonArray(raw: string): Array<{ name?: string; description?: string; files?: string[]; prompt?: string }> {
  // Try direct parse
  try {
    const parsed = JSON.parse(raw.trim())
    if (Array.isArray(parsed)) return parsed
  } catch { /* noop */ }

  // Strip markdown fences
  const stripped = raw.trim().replace(/```json\s*/g, '').replace(/```\s*/g, '')
  try {
    const parsed = JSON.parse(stripped)
    if (Array.isArray(parsed)) return parsed
  } catch { /* noop */ }

  // Extract first JSON array from surrounding text
  const firstBracket = raw.indexOf('[')
  if (firstBracket >= 0) {
    let depth = 0
    let inString = false
    let escape = false
    for (let i = firstBracket; i < raw.length; i++) {
      const ch = raw[i]
      if (escape) { escape = false; continue }
      if (ch === '\\' && inString) { escape = true; continue }
      if (ch === '"') { inString = !inString; continue }
      if (inString) continue
      if (ch === '[') depth++
      else if (ch === ']') {
        depth--
        if (depth === 0) {
          try {
            const parsed = JSON.parse(raw.slice(firstBracket, i + 1))
            if (Array.isArray(parsed)) return parsed
          } catch { break }
        }
      }
    }
  }

  console.error('[Gekto] Failed to parse task array from output')
  console.error('[Gekto] Raw (first 500 chars):', raw.slice(0, 500))
  throw new Error(`Unexpected token '${raw[0]}', "${raw.slice(0, 20)}"... is not valid JSON`)
}

// === Task Generation from Abstract ===

export interface TaskGenCallbacks {
  onTasksGenerated?: (tasks: Task[]) => void
  onError?: (error: string) => void
  onToolStart?: (tool: string, input?: Record<string, unknown>) => void
  onToolEnd?: (tool: string) => void
  onText?: (text: string) => void
  onThinking?: (text: string) => void
}

export async function generateTasksFromAbstract(
  plan: ExecutionPlan,
  workingDir: string,
  callbacks?: TaskGenCallbacks,
): Promise<Task[]> {
  const taskIdBase = plan.id.replace(/^plan_/, '')

  const userPrompt = [
    `Project goal: ${plan.originalPrompt}`,
    '',
    `Plan abstract:`,
    plan.abstract || '',
    '',
    plan.buildPrompt ? `Build step (runs after all tasks): ${plan.buildPrompt}` : '',
  ].filter(Boolean).join('\n')

  try {
    const streamCallbacks: PlanCallbacks = {
      onToolStart: callbacks?.onToolStart,
      onToolEnd: callbacks?.onToolEnd,
      onText: callbacks?.onText,
      onThinking: callbacks?.onThinking,
    }
    const result = await runClaudeOnce(userPrompt, TASK_GEN_SYSTEM, workingDir, streamCallbacks)

    // Parse JSON array of tasks — robust extraction
    const rawTasks = parseJsonArray(result)

    if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
      throw new Error('No tasks generated')
    }

    const tasks: Task[] = rawTasks.map((t, i) => ({
      id: `${taskIdBase}_${i + 1}`,
      name: (t.name || t.description || 'Task').slice(0, 50),
      description: t.description || t.name || 'Task',
      prompt: t.prompt || t.description || '',
      files: (t.files || []).filter((f: string) => f && String(f).trim()),
      status: 'pending' as const,
      dependencies: [],
      planId: plan.id,
    }))

    callbacks?.onTasksGenerated?.(tasks)
    return tasks
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to generate tasks'
    callbacks?.onError?.(errorMsg)
    // Fallback: single task from abstract
    return [{
      id: `${taskIdBase}_1`,
      name: 'Execute plan',
      description: plan.abstract || plan.originalPrompt,
      prompt: plan.abstract || plan.originalPrompt,
      files: [],
      status: 'pending' as const,
      dependencies: [],
      planId: plan.id,
    }]
  }
}

// === Claude Helper ===

function runClaudeOnce(
  prompt: string,
  systemPrompt: string,
  workingDir: string,
  callbacks?: PlanCallbacks,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--model', 'claude-sonnet-4-6',
      '--system-prompt', systemPrompt,
      '--dangerously-skip-permissions',
      '--disallowed-tools', 'Task', 'Edit', 'Write', 'Bash',
    ]

    // Note: do NOT use --resume with the shared session ID.
    // The persistent Opus process owns that session. Using --resume here
    // would conflict with it and cause exit code 1.

    const startTime = Date.now()
    console.log(`[Gekto] Spawning: "${CLAUDE_PATH}" (model: claude-sonnet-4-6, task gen)`)
    console.log(`[Gekto] CWD: ${workingDir}`)

    const proc = spawn(CLAUDE_PATH, args, {
      cwd: workingDir,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    proc.on('error', (err) => {
      console.error(`[Gekto] Spawn error:`, err)
    })

    proc.stdin?.end()

    let buffer = ''
    let resultText = ''
    let currentTool: string | null = null

    proc.stdout.on('data', (data) => {
      buffer += data.toString()

      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)

          // Log every event type for debugging
          if (event.type === 'content_block_delta') {
            const delta = event.delta as { type?: string; text?: string; thinking?: string } | undefined
            if (delta?.type === 'thinking_delta') {
              // Don't spam full thinking text, just note it's thinking
              if (!currentTool) console.log(`[Gekto] thinking...`)
            } else if (delta?.type === 'text_delta' && delta.text) {
              console.log(`[Gekto] text: ${delta.text.slice(0, 100)}`)
            }
          } else {
            console.log(`[Gekto] event: ${event.type}${event.subtype ? '/' + event.subtype : ''}`)
          }

          // Stream tool events + thinking from assistant message
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'tool_use' && block.name) {
                currentTool = block.name
                const inputSummary = block.input?.file_path || block.input?.pattern || block.input?.command?.slice(0, 80) || ''
                console.log(`[Gekto] TOOL START: ${block.name} ${inputSummary}`)
                callbacks?.onToolStart?.(block.name, block.input)
              }
              if (block.type === 'thinking' && block.thinking) {
                callbacks?.onThinking?.(block.thinking)
              }
            }
          }

          // Tool completed
          if (event.type === 'user' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'tool_result' && currentTool) {
                console.log(`[Gekto] TOOL END: ${currentTool}`)
                callbacks?.onToolEnd?.(currentTool)
                currentTool = null
              }
            }
          }

          // Text streaming (text_delta = response text, thinking_delta = extended thinking)
          if (event.type === 'content_block_delta') {
            const delta = event.delta as { type?: string; text?: string; thinking?: string } | undefined
            if (delta?.type === 'text_delta' && delta.text) {
              callbacks?.onText?.(delta.text)
            } else if (delta?.type === 'thinking_delta' && delta.thinking) {
              callbacks?.onThinking?.(delta.thinking)
            }
          }

          if (event.type === 'result' && event.result) {
            console.log(`[Gekto] RESULT received (${(event.result as string).length} chars)`)
            resultText = event.result
          }
        } catch {
          // Ignore parse errors
        }
      }
    })

    let stderrOutput = ''
    proc.stderr.on('data', (data) => {
      const chunk = data.toString()
      stderrOutput += chunk
      console.error(`[Gekto stderr] ${chunk.trim()}`)
    })

    proc.on('close', (code) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
      console.log(`[Gekto] Process closed (code=${code}, ${elapsed}s)`)

      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer)
          if (event.type === 'result' && event.result) {
            resultText = event.result
          }
        } catch {
          // Ignore
        }
      }

      if (resultText) {
        resolve(resultText)
      } else {
        const errorMsg = stderrOutput || `Process exited with code ${code}`
        reject(new Error(`No result from Gekto: ${errorMsg}`))
      }
    })

    proc.on('error', reject)
  })
}
