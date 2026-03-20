import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from 'react'
import { type Message, type ToolMessage, type FileChange } from '../store/store'
import { setRawMessageHandler, getServerState } from '../hooks/useServerState'

// Helper to save message — sends to server state via WS
function saveMessage(agentId: string, message: Message) {
  const state = getServerState()
  const existing = state.agents[agentId]?.messages || []
  const serialized = {
    ...message,
    timestamp: typeof message.timestamp === 'string' ? message.timestamp : new Date().toISOString(),
  }

  const ws = (window as unknown as { __gektoWebSocket?: WebSocket }).__gektoWebSocket
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'save_chat',
      agentId,
      messages: [...existing, serialized],
    }))
  }
}

// Helper to sync agent status to server state
function syncAgentStatus(agentId: string, status: 'idle' | 'working' | 'done' | 'pending' | 'error') {
  const state = getServerState()
  if (state.agents[agentId]) {
    const ws = (window as unknown as { __gektoWebSocket?: WebSocket }).__gektoWebSocket
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'save_state',
        path: `agents.${agentId}.status`,
        value: status,
      }))
    }
  }
}

interface ToolStatus {
  tool: string
  status: 'running' | 'completed'
  input?: string
  fullInput?: Record<string, unknown>
}

export type { FileChange } from '../store/store'

interface PermissionRequest {
  tool: string
  input?: string
  description?: string
}

type AgentState = 'ready' | 'working' | 'queued' | 'error'
type GektoState = 'loading' | 'ready' | 'error'

interface ActiveAgent {
  lizardId: string
  isProcessing: boolean
  isRunning: boolean
  queueLength: number
}

interface LizardSession {
  state: AgentState
  currentTool: ToolStatus | null
  permissionRequest: PermissionRequest | null
  queuePosition: number
  lastResponse?: string
  lastStatus?: 'done' | 'pending'
  streamingText?: string
  thinkingText?: string
  cost?: number
  duration?: number
  blockIndex?: number
}

interface AgentContextValue {
  // Actions
  sendMessage: (lizardId: string, message: string, images?: string[]) => void
  respondToPermission: (lizardId: string, approved: boolean) => void

  // Session state - exposed for reactivity
  sessions: Map<string, LizardSession>

  // Get state for a specific lizard
  getLizardState: (lizardId: string) => AgentState
  getCurrentTool: (lizardId: string) => ToolStatus | null
  getPermissionRequest: (lizardId: string) => PermissionRequest | null
  getQueuePosition: (lizardId: string) => number
  getWorkingDir: () => string
  getFileChanges: (lizardId: string) => FileChange[]
  revertFiles: (lizardId: string, filePaths: string[]) => void
  acceptAgent: (lizardId: string) => void

  // WebSocket access for GektoContext
  getWebSocket: () => WebSocket | null

  // SOS functionality
  activeAgents: ActiveAgent[]
  refreshAgentList: () => void
  killAgent: (lizardId: string) => void
  killAllAgents: () => void
  resetAgent: (lizardId: string) => void

  // Gekto state (loading/ready)
  gektoState: GektoState

  // Name extraction callback (set by SwarmContext)
  setNameExtractor: (extractor: (lizardId: string, name: string) => void) => void
}

const AgentContext = createContext<AgentContextValue | null>(null)

export function useAgent() {
  const context = useContext(AgentContext)
  if (!context) {
    throw new Error('useAgent must be used within an AgentProvider')
  }
  return context
}

interface AgentProviderProps {
  children: ReactNode
}

const DEFAULT_SESSION: LizardSession = {
  state: 'ready',
  currentTool: null,
  permissionRequest: null,
  queuePosition: 0,
}

export function AgentProvider({ children }: AgentProviderProps) {
  // Per-lizard sessions (transient state only)
  const [sessions, setSessions] = useState<Map<string, LizardSession>>(() => new Map())
  const [workingDir, setWorkingDir] = useState('')
  const [activeAgents, setActiveAgents] = useState<ActiveAgent[]>([])
  const [gektoState, setGektoState] = useState<GektoState>('loading')
  const wsRef = useRef<WebSocket | null>(null)
  const sessionsRef = useRef<Map<string, LizardSession>>(sessions)

  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  // Message listeners — initialize synchronously so child effects can register before parent effects run
  const messageListenersRef = useRef<Map<string, (message: Message) => void>>(new Map())
  if (!(window as unknown as { __agentMessageListeners?: Map<string, (message: Message) => void> }).__agentMessageListeners) {
    (window as unknown as { __agentMessageListeners: Map<string, (message: Message) => void> }).__agentMessageListeners = messageListenersRef.current
  }

  // Name extractor callback
  const nameExtractorRef = useRef<((lizardId: string, name: string) => void) | null>(null)

  const updateSession = useCallback((lizardId: string, updates: Partial<LizardSession>) => {
    setSessions(prev => {
      const next = new Map(prev)
      const current = next.get(lizardId) ?? { ...DEFAULT_SESSION }
      next.set(lizardId, { ...current, ...updates })
      return next
    })
  }, [])

  // Register raw message handler with useServerState
  useEffect(() => {
    // Get WS ref from global (set by useServerState)
    const checkWs = setInterval(() => {
      const ws = (window as unknown as { __gektoWebSocket?: WebSocket }).__gektoWebSocket
      if (ws && ws !== wsRef.current) {
        wsRef.current = ws
      }
    }, 100)

    // Handle all non-state messages (tool, text, response, etc.)
    setRawMessageHandler((msg: Record<string, unknown>) => {
      const lizardId = msg.lizardId as string | undefined

      switch (msg.type) {
        case 'state':
          if (lizardId) {
            if (msg.state === 'working') {
              updateSession(lizardId, { state: 'working', queuePosition: 0, streamingText: '', thinkingText: '', blockIndex: 0 })
              syncAgentStatus(lizardId, 'working')
            } else if (msg.state === 'ready') {
              updateSession(lizardId, { state: 'ready', currentTool: null, queuePosition: 0 })
              const session = sessionsRef.current.get(lizardId)
              // Only sync status if we observed the agent complete in this browser session.
              // On reload, lastStatus is undefined — trust server state (which already has 'done').
              if (session?.lastStatus) {
                syncAgentStatus(lizardId, session.lastStatus)
              }

              // Worker completion
              if (lizardId.startsWith('worker_')) {
                const session = sessionsRef.current.get(lizardId)
                const lastResponse = session?.lastResponse || ''
                const gektoHandler = (window as unknown as { __gektoTaskComplete?: (lizardId: string, result: string, isError: boolean) => void }).__gektoTaskComplete
                if (gektoHandler && lastResponse) {
                  gektoHandler(lizardId, lastResponse, false)
                }
              }
            } else if (msg.state === 'error') {
              updateSession(lizardId, { state: 'error' })
              syncAgentStatus(lizardId, 'error')
            }
          }
          break

        case 'gekto_state':
          setGektoState(msg.state as GektoState)
          break

        case 'queued':
          if (lizardId) {
            updateSession(lizardId, { state: 'queued', queuePosition: msg.position as number })
          }
          break

        case 'tool':
          if (lizardId) {
            const toolStatus: ToolStatus = {
              tool: msg.tool as string,
              status: msg.status as 'running' | 'completed',
              input: msg.input as string | undefined,
              fullInput: msg.fullInput as Record<string, unknown> | undefined,
            }

            if (msg.status === 'running') {
              // Increment block index so next text/thinking block gets a new ID
              const curSession = sessionsRef.current.get(lizardId) ?? { ...DEFAULT_SESSION }
              const newBlockIndex = (curSession.blockIndex ?? 0) + 1
              updateSession(lizardId, { currentTool: toolStatus, blockIndex: newBlockIndex, streamingText: '', thinkingText: '' })
              sessionsRef.current.set(lizardId, { ...curSession, currentTool: toolStatus, blockIndex: newBlockIndex, streamingText: '', thinkingText: '' })
            } else {
              updateSession(lizardId, { currentTool: toolStatus })
            }

            if (msg.status === 'running') {
              const toolMessage: Message = {
                id: `tool_${Date.now()}`,
                text: msg.tool as string,
                sender: 'bot',
                timestamp: new Date().toISOString(),
                toolUse: {
                  tool: msg.tool as string,
                  input: msg.input as string | undefined,
                  fullInput: msg.fullInput as Record<string, unknown> | undefined,
                  status: 'running',
                  startTime: new Date().toISOString(),
                },
              }
              saveMessage(lizardId, toolMessage)
              const listener = messageListenersRef.current.get(lizardId)
              if (listener) {
                listener(toolMessage)
              }
            }
          }
          break

        case 'text':
          if (lizardId) {
            let cleanText = (msg.text as string)
              .replace(/\[AGENT_NAME:[^\]]+\]\s*/g, '')
              .replace(/\[STATUS:(DONE|PENDING)\]/gi, '')
              .replace(/\[TASK_CONTEXT\][\s\S]*?\[\/TASK_CONTEXT\]\s*/g, '')
              .trim()

            if (cleanText) {
              const currentSession = sessionsRef.current.get(lizardId)
              const blockIdx = currentSession?.blockIndex ?? 0
              updateSession(lizardId, { streamingText: cleanText })
              sessionsRef.current.set(lizardId, {
                ...(currentSession ?? DEFAULT_SESSION),
                streamingText: cleanText
              })

              const listener = messageListenersRef.current.get(lizardId)
              if (listener) {
                listener({
                  id: `streaming_${lizardId}_${blockIdx}`,
                  text: cleanText,
                  sender: 'bot',
                  timestamp: new Date().toISOString(),
                  isStreaming: true,
                } as Message & { isStreaming: boolean })
              }
            }
          }
          break

        case 'thinking':
          if (lizardId) {
            const thinkingText = msg.text as string
            if (thinkingText) {
              const currentSession = sessionsRef.current.get(lizardId)
              const blockIdx = currentSession?.blockIndex ?? 0
              updateSession(lizardId, { thinkingText: thinkingText })
              sessionsRef.current.set(lizardId, {
                ...(currentSession ?? DEFAULT_SESSION),
                thinkingText: thinkingText,
              })

              const listener = messageListenersRef.current.get(lizardId)
              if (listener) {
                listener({
                  id: `thinking_${lizardId}_${blockIdx}`,
                  text: thinkingText,
                  sender: 'bot',
                  timestamp: new Date().toISOString(),
                  isStreaming: true,
                  isThinking: true,
                } as Message & { isStreaming: boolean; isThinking: boolean })
              }
            }
          }
          break

        case 'tool_result':
          if (lizardId) {
            const toolResultContent = msg.content as string
            const toolResultName = msg.tool as string
            const toolUseId = msg.toolUseId as string
            if (toolResultContent) {
              const listener = messageListenersRef.current.get(lizardId)
              if (listener) {
                listener({
                  id: `tool_result_${toolUseId || Date.now()}`,
                  text: toolResultContent,
                  sender: 'bot',
                  timestamp: new Date().toISOString(),
                  toolResult: {
                    tool: toolResultName,
                    content: toolResultContent,
                    toolUseId,
                  },
                } as Message & { toolResult: { tool: string; content: string; toolUseId: string } })
              }
            }
          }
          break

        case 'file_change':
          // File changes are tracked by server state via agentPool.ts
          // and broadcast via agent_set action — no client-side mutation needed
          break

        case 'files_reverted':
          // Server handles revert state updates and broadcasts via agent_set
          break

        case 'permission':
          if (lizardId) {
            updateSession(lizardId, {
              permissionRequest: {
                tool: msg.tool as string,
                input: msg.input as string,
                description: msg.description as string,
              }
            })
          }
          break

        case 'info':
          if (msg.workingDir) {
            setWorkingDir(msg.workingDir as string)
          }
          break

        case 'agents_list':
          setActiveAgents((msg.agents || []) as ActiveAgent[])
          if (msg.agents && (msg.agents as ActiveAgent[]).length > 0) {
            setSessions(prev => {
              const next = new Map(prev)
              for (const agent of msg.agents as ActiveAgent[] & { state?: string; queuePosition?: number; lizardId: string }[]) {
                const current = next.get(agent.lizardId) ?? { ...DEFAULT_SESSION }
                next.set(agent.lizardId, {
                  ...current,
                  state: (agent as unknown as { state?: string }).state as AgentState || 'ready',
                  queuePosition: (agent as unknown as { queuePosition?: number }).queuePosition || 0,
                })
              }
              return next
            })
          }

          // Detect orphaned agents
          {
            const serverIds = new Set(((msg.agents || []) as ActiveAgent[]).map(a => a.lizardId))
            const state = getServerState()
            for (const [agentId, agent] of Object.entries(state.agents)) {
              if (agent.status === 'working' && !serverIds.has(agentId)) {
                const task = agent.taskId ? state.tasks[agent.taskId] : undefined
                const ws = wsRef.current
                if (task?.prompt && ws && ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    type: 'resume_agent',
                    lizardId: agentId,
                    sessionId: task.sessionId,
                    prompt: task.prompt,
                  }))
                }
              }
            }
          }
          break

        case 'kill_result':
        case 'kill_all_result': {
          const ws = wsRef.current
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'list_agents' }))
          }
          break
        }

        case 'debug_pool_result':
          break

        // Plan/Gekto messages - forward to GektoContext
        case 'plan_created':
        case 'gekto_chat':
        case 'gekto_text':
        case 'gekto_thinking':
        case 'gekto_tool_start':
        case 'gekto_tool_end':
        case 'gekto_done':
        case 'gekto_remove':
        case 'gekto_delegate':
        case 'planning_started':
        case 'tasks_generated':
        case 'session_restored': {
          const gektoHandler = (window as unknown as { __gektoMessageHandler?: (msg: unknown) => void }).__gektoMessageHandler
          if (gektoHandler) {
            gektoHandler(msg)
          }
          break
        }

        case 'response':
        case 'error': {
          let text = msg.type === 'error' ? `Error: ${msg.message}` : msg.text as string
          let extractedStatus: 'done' | 'pending' | undefined

          if (lizardId && msg.type === 'response') {
            const nameMatch = text.match(/^\[AGENT_NAME:([^\]]+)\]\s*/)
            if (nameMatch) {
              const extractedName = nameMatch[1].trim()
              text = text.replace(nameMatch[0], '')
              if (nameExtractorRef.current) {
                nameExtractorRef.current(lizardId, extractedName)
              }
            }

            const statusMatch = text.match(/\[STATUS:(DONE|PENDING)\]/i)
            if (statusMatch) {
              extractedStatus = statusMatch[1].toLowerCase() as 'done' | 'pending'
              text = text.replace(statusMatch[0], '').trim()
            }
          }

          const responseCost = msg.cost as number | undefined
          const responseDuration = msg.duration as number | undefined

          const newMessage: Message = {
            id: Date.now().toString(),
            text,
            sender: 'bot',
            timestamp: new Date().toISOString(),
            cost: responseCost,
            duration: responseDuration,
          }

          // Save sessionId to task for recovery
          if (lizardId && msg.sessionId) {
            const state = getServerState()
            const agent = state.agents[lizardId]
            if (agent?.taskId) {
              const ws = wsRef.current
              if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  type: 'save_state',
                  path: `tasks.${agent.taskId}.sessionId`,
                  value: msg.sessionId,
                }))
              }
            }
          }

          if (lizardId) {
            // Save full response for chat history (persistence on reload)
            saveMessage(lizardId, newMessage)

            const listener = messageListenersRef.current.get(lizardId)
            if (listener) {
              if (msg.type === 'error') {
                // Errors always show as a new message
                listener(newMessage)
              } else {
                // Send finalize signal — stops streaming, adds cost/duration
                // Don't duplicate the text since it's already shown via streaming blocks
                listener({
                  id: `finalize_${Date.now()}`,
                  text: '',
                  sender: 'bot',
                  timestamp: new Date().toISOString(),
                  isFinalize: true,
                  cost: responseCost,
                  duration: responseDuration,
                } as Message & { isFinalize: boolean })
              }
            }

            const statusToStore = extractedStatus || 'pending'
            updateSession(lizardId, { lastResponse: text, lastStatus: statusToStore, streamingText: '', thinkingText: '', cost: responseCost, duration: responseDuration })
            const currentSession = sessionsRef.current.get(lizardId) ?? { ...DEFAULT_SESSION }
            sessionsRef.current.set(lizardId, { ...currentSession, lastResponse: text, lastStatus: statusToStore, streamingText: '', thinkingText: '', cost: responseCost, duration: responseDuration })

            // Worker error → mark task failed
            if (lizardId.startsWith('worker_') && msg.type === 'error') {
              const gektoHandler = (window as unknown as { __gektoTaskComplete?: (lizardId: string, result: string, isError: boolean) => void }).__gektoTaskComplete
              if (gektoHandler) {
                gektoHandler(lizardId, text, true)
              }
            }
          }

          // Refresh agents list
          const ws = wsRef.current
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'list_agents' }))
          }
          break
        }
      }
    })

    return () => {
      clearInterval(checkWs)
      setRawMessageHandler(null)
    }
  }, [updateSession])

  const sendMessage = useCallback((lizardId: string, message: string, images?: string[]) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    updateSession(lizardId, { state: 'working' })

    const payload: Record<string, unknown> = {
      type: 'chat',
      lizardId,
      content: message,
    }
    if (images && images.length > 0) {
      payload.images = images
    }
    ws.send(JSON.stringify(payload))
  }, [updateSession])

  const respondToPermission = useCallback((lizardId: string, approved: boolean) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    ws.send(JSON.stringify({
      type: 'permission_response',
      lizardId,
      approved,
    }))

    updateSession(lizardId, { permissionRequest: null })
  }, [updateSession])

  const getLizardState = useCallback((lizardId: string): AgentState => {
    const sessionState = sessions.get(lizardId)?.state
    if (sessionState && sessionState !== 'ready') {
      return sessionState
    }
    const serverAgent = activeAgents.find(a => a.lizardId === lizardId)
    if (serverAgent?.isRunning || serverAgent?.isProcessing) {
      return 'working'
    }
    return sessionState ?? 'ready'
  }, [sessions, activeAgents])

  const getCurrentTool = useCallback((lizardId: string): ToolStatus | null => {
    return sessions.get(lizardId)?.currentTool ?? null
  }, [sessions])

  const getPermissionRequest = useCallback((lizardId: string): PermissionRequest | null => {
    return sessions.get(lizardId)?.permissionRequest ?? null
  }, [sessions])

  const getQueuePosition = useCallback((lizardId: string): number => {
    return sessions.get(lizardId)?.queuePosition ?? 0
  }, [sessions])

  const getFileChanges = useCallback((lizardId: string): FileChange[] => {
    return getServerState().agents[lizardId]?.fileChanges ?? []
  }, [])

  const revertFiles = useCallback((lizardId: string, filePaths: string[]) => {
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    const agentFileChanges = getServerState().agents[lizardId]?.fileChanges ?? []
    const relevantChanges = agentFileChanges.filter(fc => filePaths.includes(fc.filePath))
    ws.send(JSON.stringify({
      type: 'revert_files',
      lizardId,
      filePaths,
      fileChanges: relevantChanges,
    }))
  }, [])

  const acceptAgent = useCallback((lizardId: string) => {
    const state = getServerState()
    const agent = state.agents[lizardId]
    if (agent?.taskId) {
      const ws = wsRef.current
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'save_state',
          path: `tasks.${agent.taskId}.status`,
          value: 'completed',
        }))
      }
    }
    // Remove agent
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'delete_agent', agentId: lizardId }))
    }
    // Clean up transient session
    setSessions(prev => {
      const next = new Map(prev)
      next.delete(lizardId)
      return next
    })
  }, [])

  const getWorkingDirFn = useCallback((): string => {
    return workingDir
  }, [workingDir])

  const refreshAgentList = useCallback(() => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'list_agents' }))
    }
  }, [])

  const killAgent = useCallback((lizardId: string) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'kill', lizardId }))
    }
  }, [])

  const resetAgent = useCallback((lizardId: string) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'reset', lizardId }))
    }
  }, [])

  const killAllAgents = useCallback(() => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'kill_all' }))
    }
  }, [])

  const setNameExtractor = useCallback((extractor: (lizardId: string, name: string) => void) => {
    nameExtractorRef.current = extractor
  }, [])

  const getWebSocketFn = useCallback((): WebSocket | null => {
    return wsRef.current
  }, [])

  const value: AgentContextValue = {
    sendMessage,
    respondToPermission,
    sessions,
    getLizardState,
    getCurrentTool,
    getPermissionRequest,
    getQueuePosition,
    getFileChanges,
    revertFiles,
    acceptAgent,
    getWorkingDir: getWorkingDirFn,
    getWebSocket: getWebSocketFn,
    activeAgents,
    refreshAgentList,
    killAgent,
    killAllAgents,
    resetAgent,
    gektoState,
    setNameExtractor,
  }

  return (
    <AgentContext.Provider value={value}>
      {children}
    </AgentContext.Provider>
  )
}

// Hook for ChatWindow to register as message listener
export function useAgentMessageListener(lizardId: string, onMessage: (message: Message) => void) {
  useEffect(() => {
    const listeners = (window as unknown as { __agentMessageListeners?: Map<string, (message: Message) => void> }).__agentMessageListeners
    if (listeners) {
      listeners.set(lizardId, onMessage)
      return () => {
        listeners.delete(lizardId)
      }
    }
  }, [lizardId, onMessage])
}

export type { Message, ToolMessage, ToolStatus, PermissionRequest, AgentState, GektoState }
