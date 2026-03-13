// Shared types for agent system

// === Agent Provider Interface ===

export interface AgentProvider {
  send(message: string, callbacks?: StreamCallbacks, imagePaths?: string[]): Promise<AgentResponse>
  kill(): boolean
  isRunning(): boolean
  getSessionId(): string | null
  setSessionId(id: string): void
  resetSession(): void
}

export interface StreamCallbacks {
  onToolStart?: (tool: string, input?: Record<string, unknown>) => void
  onToolEnd?: (tool: string) => void
  onText?: (text: string) => void
  onThinking?: (text: string) => void
  onToolResult?: (tool: string, content: string, toolUseId: string) => void
  onFileChange?: (change: FileChange) => void
}

export interface AgentResponse {
  type: string
  subtype: string
  is_error: boolean
  result: string
  session_id: string
  total_cost_usd: number
  duration_ms: number
}

export interface AgentConfig {
  systemPrompt?: string
  workingDir?: string
  disallowedTools?: string[]
}

export interface FileChange {
  tool: 'Write' | 'Edit'
  filePath: string
  before: string | null  // null if file didn't exist
  after: string
  agentId?: string
  taskId?: string
  timestamp?: string
}

// === Gekto Types ===

export type TaskStatus = 'pending' | 'in_progress' | 'pending_testing' | 'completed' | 'failed'

export interface Task {
  id: string
  name: string
  description: string
  prompt: string
  files: string[]
  fileActions?: Record<string, 'create' | 'edit'>
  status: TaskStatus
  dependencies: string[]
  planId?: string
  assignedAgentId?: string
  result?: string
  error?: string
  sessionId?: string
}

export type ExecutionPlanStatus = 'planning' | 'draft' | 'ready' | 'generating_prompts' | 'prompts_ready' | 'executing' | 'completed' | 'failed'

export interface ExecutionPlan {
  id: string
  status: ExecutionPlanStatus
  title?: string
  originalPrompt: string
  abstract?: string
  reasoning?: string
  buildPrompt?: string
  taskIds: string[]
  createdAt: string
}

export interface GektoToolResult {
  type: 'chat' | 'build' | 'remove'
  message?: string
  plan?: ExecutionPlan
  tasks?: Task[]
  removedAgents?: string[]
}
