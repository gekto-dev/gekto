import { spawn } from 'child_process'
import { CLAUDE_PATH } from '../claudePath.js'
import { sendPlanningPrompt, type GektoCallbacks } from './gektoPersistent.js'
import type { Task, ExecutionPlan, GektoToolResult } from './types.js'

// Re-export types for backward compatibility
export type { Task, ExecutionPlan, GektoToolResult } from './types.js'

// Phase 1: Generate task outline (names, files, brief descriptions)
const OUTLINE_SYSTEM = `You are a senior engineer breaking a plan into concrete coding tasks.
Given a plan abstract and project context, output a JSON array of task outlines.

Each outline object must have:
- "name": 2-4 word title, like a commit subject. Examples: "Add search bar", "Sidebar CRUD", "Drag-to-reorder". NEVER more than 5 words.
- "description": what this task does (1-2 sentences)
- "files": array of specific file paths to create/modify

Rules:
- 3-7 tasks, ALL run in parallel (no dependencies between them)
- Tasks MUST NOT overlap on files — each file belongs to exactly one task
- No "research" or "scaffold" tasks
- Each task must be self-contained

Output ONLY a valid JSON array of outline objects, nothing else. No markdown wrapping.`

// Phase 2: Generate detailed prompt for a single task
const DETAIL_SYSTEM = `You are a senior engineer writing a detailed implementation prompt for a coding agent.
You will receive the overall plan, the full task outline (all tasks), and the specific task you must detail.

Output a JSON object with:
- "prompt": detailed agent prompt (100-300 words) telling the agent:
  - Specific files to create/modify (ONLY the files assigned to this task)
  - Implementation approach
  - Edge cases to handle
  - What "done" looks like
  - MUST include: "Do NOT import from files created by other tasks"

Output ONLY a valid JSON object, nothing else. No markdown wrapping.`

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
  onTaskReady?: (task: Task) => void
  onError?: (error: string) => void
  onToolStart?: (tool: string, input?: Record<string, unknown>) => void
  onToolEnd?: (tool: string) => void
  onText?: (text: string) => void
  onThinking?: (text: string) => void
}

// Outline shape from Phase 1
interface TaskOutline {
  name: string
  description: string
  files: string[]
}

/**
 * Phase 1: Generate task outlines (names, files, brief descriptions).
 * Fast call — Claude only outputs a small JSON array.
 */
async function generateOutline(
  plan: ExecutionPlan,
  workingDir: string,
  callbacks?: PlanCallbacks,
): Promise<TaskOutline[]> {
  const userPrompt = [
    `Project goal: ${plan.originalPrompt}`,
    '',
    `Plan abstract:`,
    plan.abstract || '',
    '',
    plan.buildPrompt ? `Build step (runs after all tasks): ${plan.buildPrompt}` : '',
  ].filter(Boolean).join('\n')

  const raw = await runClaudeOnce(userPrompt, OUTLINE_SYSTEM, workingDir, callbacks)
  const parsed = parseJsonArray(raw) as TaskOutline[]

  if (!parsed.length) throw new Error('No task outlines generated')
  return parsed
}

/**
 * Phase 2: Generate detailed prompt for a single task.
 * Each call gets the full outline context so it knows about other tasks.
 */
async function generateDetail(
  plan: ExecutionPlan,
  outlines: TaskOutline[],
  taskIndex: number,
  workingDir: string,
): Promise<string> {
  const outline = outlines[taskIndex]
  const userPrompt = [
    `Project goal: ${plan.originalPrompt}`,
    '',
    `Plan abstract:`,
    plan.abstract || '',
    '',
    `ALL tasks in this plan (for context — do NOT generate prompts for other tasks):`,
    ...outlines.map((o, i) => `${i + 1}. "${o.name}" — ${o.description} [files: ${o.files.join(', ')}]`),
    '',
    `YOUR TASK (#${taskIndex + 1}): "${outline.name}"`,
    `Description: ${outline.description}`,
    `Files: ${outline.files.join(', ')}`,
    '',
    `Generate the detailed implementation prompt for THIS task only.`,
  ].join('\n')

  const raw = await runClaudeOnce(userPrompt, DETAIL_SYSTEM, workingDir)

  // Parse JSON object with "prompt" field
  try {
    const obj = JSON.parse(raw.trim().replace(/```json\s*/g, '').replace(/```\s*/g, ''))
    return obj.prompt || raw
  } catch {
    // If not valid JSON, use raw text as prompt
    return raw
  }
}

/**
 * Two-phase task generation:
 * 1. One call to get outlines (fast, ~3-4s)
 * 2. Parallel calls to get detailed prompts (~5s each, all at once)
 * Tasks appear progressively as each parallel call resolves.
 */
export async function generateTasksFromAbstract(
  plan: ExecutionPlan,
  workingDir: string,
  callbacks?: TaskGenCallbacks,
): Promise<Task[]> {
  const taskIdBase = plan.id.replace(/^plan_/, '')

  try {
    // Phase 1: Generate outlines
    console.log('[Gekto] Phase 1: Generating task outlines...')
    const outlineCallbacks: PlanCallbacks = {
      onToolStart: callbacks?.onToolStart,
      onToolEnd: callbacks?.onToolEnd,
      onText: callbacks?.onText,
      onThinking: callbacks?.onThinking,
    }
    const outlines = await generateOutline(plan, workingDir, outlineCallbacks)
    console.log(`[Gekto] Phase 1 done: ${outlines.length} outlines`)

    // Emit skeleton tasks immediately (with empty prompts) so UI shows them
    const tasks: Task[] = outlines.map((outline, i) => ({
      id: `${taskIdBase}_${i + 1}`,
      name: (outline.name || 'Task').slice(0, 50),
      description: outline.description || outline.name || 'Task',
      prompt: '', // filled in Phase 2
      files: (outline.files || []).filter((f: string) => f && String(f).trim()),
      status: 'pending' as const,
      dependencies: [],
      planId: plan.id,
    }))

    // Notify UI of each skeleton task
    for (const task of tasks) {
      callbacks?.onTaskReady?.(task)
    }

    // Phase 2: Generate detailed prompts in parallel
    console.log(`[Gekto] Phase 2: Generating ${outlines.length} detail prompts in parallel...`)
    const detailPromises = outlines.map((_, i) =>
      generateDetail(plan, outlines, i, workingDir)
        .then((prompt) => {
          tasks[i].prompt = prompt
          // Update the task in UI with the detailed prompt
          callbacks?.onTaskReady?.(tasks[i])
          console.log(`[Gekto] Phase 2: Task ${i + 1}/${outlines.length} detail ready`)
        })
        .catch((err) => {
          console.error(`[Gekto] Phase 2: Task ${i + 1} detail failed:`, err)
          // Use description as fallback prompt
          tasks[i].prompt = tasks[i].description
        })
    )

    await Promise.all(detailPromises)
    console.log('[Gekto] Phase 2 done: All detail prompts generated')

    callbacks?.onTasksGenerated?.(tasks)
    return tasks
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to generate tasks'
    callbacks?.onError?.(errorMsg)
    // Fallback: single task from abstract
    const fallback: Task = {
      id: `${taskIdBase}_1`,
      name: 'Execute plan',
      description: plan.abstract || plan.originalPrompt,
      prompt: plan.abstract || plan.originalPrompt,
      files: [],
      status: 'pending' as const,
      dependencies: [],
      planId: plan.id,
    }
    callbacks?.onTaskReady?.(fallback)
    return [fallback]
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
