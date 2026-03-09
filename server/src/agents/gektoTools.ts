import { spawn } from 'child_process'
import { CLAUDE_PATH } from '../claudePath.js'
import { sendPlanningPrompt, type GektoCallbacks } from './gektoPersistent.js'
import type { Task, ExecutionPlan, GektoToolResult } from './types.js'

// Re-export types for backward compatibility
export type { Task, ExecutionPlan, GektoToolResult } from './types.js'

// Step 2: Generate a detailed prompt for a single task (runs in parallel for each task)
const PROMPT_GEN_SYSTEM = `You are a senior engineer writing a detailed task prompt for a coding agent.
Given a task description and project context, write a clear, actionable prompt (100-300 words) that tells the agent:
- Specific files to create/modify
- Implementation approach
- Edge cases to handle
- What "done" looks like
- MUST include: "Do NOT import from files created by other tasks"

Output ONLY the prompt text, nothing else. No JSON, no markdown wrapping.`

// === Callbacks for streaming events ===

export interface PlanCallbacks {
  onToolStart?: (tool: string, input?: Record<string, unknown>) => void
  onToolEnd?: (tool: string) => void
  onText?: (text: string) => void
  onThinking?: (text: string) => void
}

// Existing plan context for modifications
interface ExistingPlanContext {
  tasks: { id: string; description: string; prompt: string; files: string[]; dependencies: string[] }[]
  reasoning?: string
}

// === Structured output parsing ===

interface GektoStructuredOutput {
  action: 'create_plan' | 'reply' | 'clarify' | 'remove_agents' | 'update_plan'
  message?: string
  reasoning?: string
  buildPrompt?: string
  tasks?: Partial<Task>[]
  target?: string
}

function parseGektoOutput(raw: string): GektoStructuredOutput | null {
  // With --json-schema, output should be valid JSON. Try direct parse first.
  try {
    return JSON.parse(raw)
  } catch {
    // Fallback: strip markdown fences and retry
    const stripped = raw.trim().replace(/```json\s*/g, '').replace(/```\s*/g, '')
    try {
      return JSON.parse(stripped)
    } catch (err) {
      console.error('[Gekto] Failed to parse structured output:', err)
      console.error('[Gekto] Raw output (first 500 chars):', raw.slice(0, 500))
      return null
    }
  }
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
  if (existingPlan && existingPlan.tasks.length > 0) {
    const taskList = existingPlan.tasks.map((t, i) =>
      `  ${i + 1}. ${t.description} (files: ${t.files.join(', ') || 'none'})`
    ).join('\n')

    contextPrompt += `\n\n[EXISTING PLAN - User wants to modify this plan:
Reasoning: ${existingPlan.reasoning || 'Not provided'}
Tasks:
${taskList}

The user's message above is a modification request. You can:
- Add new tasks to the existing ones
- Remove specific tasks
- Modify task descriptions or prompts
- Respond with clarify if you need clarification

If modifying, use update_plan with ALL tasks (existing + changes).]`
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
      const result = createPlanFromTasks(parsed.tasks || [], planId, prompt, parsed.reasoning, parsed.buildPrompt)
      return {
        type: 'build',
        plan: result.plan,
        tasks: result.tasks,
        message: parsed.message || parsed.reasoning,
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

interface CreatePlanResult {
  plan: ExecutionPlan
  tasks: Task[]
}

function createPlanFromTasks(
  tasks: Partial<Task>[],
  planId: string,
  originalPrompt: string,
  reasoning?: string,
  buildPrompt?: string
): CreatePlanResult {
  // Extract taskId from planId (planId format: "plan_test_123456")
  // taskId should be "test_123456" for task IDs like "test_123456_1"
  const taskId = planId.replace(/^plan_/, '')

  // Use same format as hardcoded Test button: test_X_1, test_X_2, etc.
  const parsedTasks: Task[] = tasks.map((t, i) => ({
    id: `${taskId}_${i + 1}`,
    name: (t.description || 'Task').slice(0, 50),
    description: t.description || 'Task',
    prompt: '',  // Prompts are generated in a separate parallel step
    files: (t.files || []).filter(f => f && String(f).trim()),
    status: 'pending' as const,
    dependencies: t.dependencies || [],
    planId,
  }))

  // Fallback to single task if empty
  if (parsedTasks.length === 0) {
    parsedTasks.push({
      id: `${taskId}_1`,
      name: 'Execute task',
      description: 'Execute task',
      prompt: originalPrompt,
      files: [],
      status: 'pending',
      dependencies: [],
      planId,
    })
  }

  return {
    plan: {
      id: planId,
      status: 'ready',
      originalPrompt,
      reasoning,
      buildPrompt,
      taskIds: parsedTasks.map(t => t.id),
      createdAt: new Date().toISOString(),
    },
    tasks: parsedTasks,
  }
}

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

// === Parallel Prompt Generation ===

export interface PromptGenCallbacks {
  onTaskPromptGenerated?: (taskId: string, prompt: string) => void
  onAllPromptsReady?: () => void
  onError?: (taskId: string, error: string) => void
}

export async function generateTaskPrompts(
  plan: ExecutionPlan,
  tasks: Task[],
  workingDir: string,
  callbacks?: PromptGenCallbacks,
): Promise<Map<string, string>> {
  // Build shared context about the plan
  const planContext = [
    `Project goal: ${plan.originalPrompt}`,
    `Plan reasoning: ${plan.reasoning || 'N/A'}`,
    '',
    'All tasks in the plan:',
    ...tasks.map((t, i) => `  ${i + 1}. ${t.description} (files: ${t.files.join(', ') || 'read-only'})`),
    '',
    plan.buildPrompt ? `Build step (runs after all tasks): ${plan.buildPrompt}` : '',
  ].filter(Boolean).join('\n')

  // Generate prompts in parallel
  const promptPromises = tasks.map(async (task) => {
    const userPrompt = [
      planContext,
      '',
      `--- YOUR TASK ---`,
      `Description: ${task.description}`,
      `Files to create/modify: ${task.files.join(', ') || 'none (read-only research task)'}`,
      `Dependencies: ${task.dependencies.join(', ') || 'none'}`,
    ].join('\n')

    try {
      const prompt = await runClaudeOnce(userPrompt, PROMPT_GEN_SYSTEM, workingDir)
      callbacks?.onTaskPromptGenerated?.(task.id, prompt.trim())
      return { taskId: task.id, prompt: prompt.trim() }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to generate prompt'
      callbacks?.onError?.(task.id, errorMsg)
      // Fallback: use description as prompt
      return { taskId: task.id, prompt: task.description }
    }
  })

  const results = await Promise.all(promptPromises)

  callbacks?.onAllPromptsReady?.()
  return new Map(results.map(r => [r.taskId, r.prompt]))
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
      '--model', 'claude-opus-4-5-20251101',
      '--system-prompt', systemPrompt,
      '--dangerously-skip-permissions',
      '--disallowed-tools', 'Task', 'Edit', 'Write', 'Bash',
    ]

    // Note: do NOT use --resume with the shared session ID.
    // The persistent Opus process owns that session. Using --resume here
    // would conflict with it and cause exit code 1.

    const startTime = Date.now()
    console.log(`[Gekto] Spawning: "${CLAUDE_PATH}" (model: claude-sonnet-4-6)`)
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
