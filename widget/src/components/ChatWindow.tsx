import { useState, useRef, useEffect, useCallback, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { FileTextIcon, TrashIcon, ImageIcon, CounterClockwiseClockIcon } from '@radix-ui/react-icons'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAgent, useAgentMessageListener, type Message } from '../context/AgentContext'
import { useGekto } from '../context/GektoContext'
import { useStore } from '../store/store'
import { useServerState, getServerState, updateLocalAgentMessages, updateLocalCurrentMasterId } from '../hooks/useServerState'

const MASTER_ID = 'master'
const CHAT_SIZE_KEY = 'gekto-chat-size'

const AGENT_PHRASES = [
  'Hacking...',
  'Swarming...',
  'Gektoing...',
  'Crawling...',
  'Shedding...',
  'Scaling...',
  'Slithering...',
  'Chomping...',
  'Molting...',
  'Debugging...',
  'Spawning...',
]

const THINKING_PHRASES = [
  'Thinking...',
  'Gektoing...',
  'Swirling...',
  'Analyzing...',
  'Lizarding...',
]

// Default chat size
const DEFAULT_CHAT_SIZE = { width: 400, height: 500 }

// Load saved size from localStorage
export function getChatSize(): { width: number; height: number } {
  try {
    const saved = localStorage.getItem(CHAT_SIZE_KEY)
    if (saved) {
      return JSON.parse(saved)
    }
  } catch {
    // ignore
  }
  return DEFAULT_CHAT_SIZE
}

// Save size to localStorage
function saveSizeToStorage(size: { width: number; height: number }) {
  try {
    localStorage.setItem(CHAT_SIZE_KEY, JSON.stringify(size))
  } catch {
    // ignore
  }
}

type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

interface ChatWindowProps {
  lizardId: string
  title?: string
  minSize?: { width: number; height: number }
  color?: string
  onClose?: () => void
  onResize?: (size: { width: number; height: number }) => void
  inputRef?: React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>
  onHeaderMouseDown?: (e: React.MouseEvent) => void
}

export function ChatWindow({
  lizardId,
  title = 'Gekto Chat',
  minSize = { width: 300, height: 350 },
  color = 'rgba(255, 255, 255, 0.5)',
  onClose,
  onResize,
  inputRef,
  onHeaderMouseDown,
}: ChatWindowProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [inputValue, setInputValue] = useState('')
  const [size, setSize] = useState(() => getChatSize())
  const [isResizing, setIsResizing] = useState(false)
  const [resizeDirection, setResizeDirection] = useState<ResizeDirection | null>(null)
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set())
  const [expandedThinking, setExpandedThinking] = useState<Set<string>>(new Set())
  const [stagedImages, setStagedImages] = useState<string[]>([])
  const [isDraggingOver, setIsDraggingOver] = useState(false)
  const [isRestoredSession, setIsRestoredSession] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [showPlansList, setShowPlansList] = useState(false)
  const [confirmDeletePlanId, setConfirmDeletePlanId] = useState<string | null>(null)
  const [historySessions, setHistorySessions] = useState<Array<{ id: string; createdAt: string; preview: string; messageCount: number; isCurrent: boolean }>>([])
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const historyRef = useRef<HTMLDivElement>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const resizeStart = useRef({ x: 0, y: 0, width: 0, height: 0 })

  const {
    sendMessage,
    respondToPermission,
    sessions,
    getLizardState,
    getCurrentTool,
    getPermissionRequest,
    gektoState,
    killAgent,
    resetAgent,
  } = useAgent()

  const { createPlan, currentPlan, activePlans, selectedPlanId, isCreatingNewPlan, selectPlan, createNewPlan, openPlanPanel, cancelPlan, markTaskInProgress } = useGekto()
  const { state: serverState, send: sendToServer, isReady: serverReady } = useServerState()
  // Get agent/task names from global store
  const agents = useStore((s) => s.agents)
  const tasks = useStore((s) => s.tasks)
  const agent = agents[lizardId]
  const task = agent?.taskId ? tasks[agent.taskId] : undefined
  const agentName = task?.name

  const isMaster = lizardId === MASTER_ID
  const activePlanCount = Object.values(activePlans).filter(p => p.status !== 'completed' && p.status !== 'failed').length
  const hasActivePlan = isMaster && activePlanCount > 0
  const isGektoLoading = isMaster && gektoState === 'loading'

  // Rotating thinking phrases for master
  const [masterPhraseIndex, setMasterPhraseIndex] = useState(0)
  const isMasterWorking = isMaster && (sessions.get(lizardId)?.state ?? getLizardState(lizardId)) === 'working'

  useEffect(() => {
    if (!isMasterWorking) {
      setMasterPhraseIndex(0)
      return
    }
    const interval = setInterval(() => {
      setMasterPhraseIndex(() => {
        return 1 + Math.floor(Math.random() * (THINKING_PHRASES.length - 1))
      })
    }, 3000)
    return () => clearInterval(interval)
  }, [isMasterWorking])

  // Rotating phrases for regular agents
  const [agentPhraseIndex, setAgentPhraseIndex] = useState(0)
  const isAgentWorking = !isMaster && (sessions.get(lizardId)?.state ?? getLizardState(lizardId)) === 'working'

  useEffect(() => {
    if (!isAgentWorking) {
      setAgentPhraseIndex(0)
      return
    }
    const interval = setInterval(() => {
      setAgentPhraseIndex(() => Math.floor(Math.random() * AGENT_PHRASES.length))
    }, 2000)
    return () => clearInterval(interval)
  }, [isAgentWorking])


  // Subscribe to sessions to trigger re-render on state changes
  const agentState = sessions.get(lizardId)?.state ?? getLizardState(lizardId)
  const currentTool = getCurrentTool(lizardId)
  const permissionRequest = getPermissionRequest(lizardId)



  // Handle incoming messages from agent (name extraction is done in AgentContext)
  const handleAgentMessage = useCallback((message: Message & { isStreaming?: boolean; isThinking?: boolean; isFinalize?: boolean; toolResult?: { tool: string; content: string; toolUseId: string } }) => {
    if (message.isFinalize) {
      // Finalize: stop streaming animations, add cost/duration to last text message
      setMessages(prev => {
        const updated = prev.map(m => {
          if (m.isStreaming) {
            return { ...m, isStreaming: false }
          }
          return m
        })
        // Add cost/duration to the last non-tool bot message
        if (message.cost != null || message.duration != null) {
          for (let i = updated.length - 1; i >= 0; i--) {
            if (updated[i].sender === 'bot' && !updated[i].toolUse && !updated[i].isThinking) {
              updated[i] = { ...updated[i], cost: message.cost, duration: message.duration }
              break
            }
          }
        }
        return updated
      })
    } else if (message.isThinking) {
      // Thinking message: replace existing thinking entry with same ID, or append
      setMessages(prev => {
        const idx = prev.findIndex(m => m.id === message.id)
        if (idx >= 0) {
          const updated = [...prev]
          updated[idx] = message
          return updated
        }
        return [...prev, message]
      })
    } else if (message.isStreaming) {
      // Streaming text: replace existing entry with same ID, or append
      setMessages(prev => {
        const idx = prev.findIndex(m => m.id === message.id)
        if (idx >= 0) {
          const updated = [...prev]
          updated[idx] = message
          return updated
        }
        return [...prev, message]
      })
    } else if (message.toolResult) {
      // Tool result: attach content to the last tool message for this tool
      setMessages(prev => {
        const updated = [...prev]
        for (let i = updated.length - 1; i >= 0; i--) {
          if (updated[i].toolUse && updated[i].toolUse!.tool === message.toolResult!.tool) {
            updated[i] = {
              ...updated[i],
              toolResult: message.toolResult,
            }
            return updated
          }
        }
        return prev
      })
    } else if (message.toolUse) {
      // Tool message: just append
      setMessages(prev => [...prev, message])
    } else {
      // Error or other message: just append (don't remove streaming blocks)
      setMessages(prev => [...prev, message])
    }
  }, [])

  // Register as message listener
  useAgentMessageListener(lizardId, handleAgentMessage)

  // Load chat history from server state — waits for snapshot before deciding
  // For master, resolve to the actual master session ID (e.g. master_1772966060233)
  const resolvedMasterId = isMaster ? serverState.currentMasterId : lizardId
  const agentMessages = serverState.agents[resolvedMasterId || lizardId]?.messages

  // Reset history when the resolved master changes (e.g. session restore/archive)
  const prevResolvedRef = useRef(resolvedMasterId)
  useEffect(() => {
    if (prevResolvedRef.current !== resolvedMasterId) {
      prevResolvedRef.current = resolvedMasterId
      setMessages([])
      setHistoryLoaded(false)
    }
  }, [resolvedMasterId])

  // Keep a ref to the latest messages for defensive checks
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  useEffect(() => {
    if (historyLoaded || !serverReady) return

    console.log('[ChatWindow] History loading:', { messagesLen: messagesRef.current.length, agentMessagesLen: agentMessages?.length, resolvedMasterId })

    // If we already have real messages in local state (e.g. from before HMR/reconnect),
    // don't overwrite them with potentially stale server data
    if (messagesRef.current.length > 1 || (messagesRef.current.length === 1 && messagesRef.current[0].sender === 'user')) {
      console.log('[ChatWindow] Skipping load — already have messages')
      setHistoryLoaded(true)
      return
    }

    if (agentMessages && agentMessages.length > 0) {
      console.log('[ChatWindow] Loading', agentMessages.length, 'messages from server')
      // Server has history — load it
      setMessages(agentMessages.map(m => ({
        ...m,
        timestamp: typeof m.timestamp === 'string' ? new Date(m.timestamp) : m.timestamp,
        // Restore isThinking from persisted flag or ID pattern (legacy data)
        isThinking: m.isThinking || m.id.includes('_thinking_'),
        toolUse: m.toolUse ? {
          ...m.toolUse,
          startTime: typeof m.toolUse.startTime === 'string' ? new Date(m.toolUse.startTime) : m.toolUse.startTime,
          endTime: m.toolUse.endTime
            ? (typeof m.toolUse.endTime === 'string' ? new Date(m.toolUse.endTime) : m.toolUse.endTime)
            : undefined,
        } : undefined,
      })) as Message[])
    } else {
      console.log('[ChatWindow] No server messages — showing greeting')
      // Server has no history — show greeting
      const greeting = lizardId === MASTER_ID
        ? `**Hey, I'm Gekto** — your project manager.\n\nI research the codebase, break your request into parallel tasks, and spawn agents to execute them.`
        : 'Hi! How can I help you today?'
      setMessages([{ id: '1', text: greeting, sender: 'bot', timestamp: new Date() }])
    }
    setHistoryLoaded(true)
  }, [agentMessages, serverReady, historyLoaded, lizardId, resolvedMasterId])

  // Save chat history when messages change (for master/agents without tasks)
  // Chat messages for agents with tasks are saved via AgentContext
  // historyLoaded is only set after snapshot arrives, so greeting can't overwrite real history
  useEffect(() => {
    if (!historyLoaded || messages.length === 0) return
    // Skip if agent has a task (saved by AgentContext)
    if (agent?.taskId) return

    const toIso = (v: Date | string): string => v instanceof Date ? v.toISOString() : String(v)
    const toSave = messages.map(m => ({
      id: m.id,
      text: m.text,
      sender: m.sender,
      timestamp: toIso(m.timestamp),
      isTerminal: m.isTerminal,
      isThinking: m.isThinking,
      images: m.images,
      toolUse: m.toolUse ? {
        tool: m.toolUse.tool,
        input: m.toolUse.input,
        fullInput: m.toolUse.fullInput,
        status: m.toolUse.status,
        startTime: toIso(m.toolUse.startTime),
        endTime: m.toolUse.endTime ? toIso(m.toolUse.endTime) : undefined,
      } : undefined,
    }))

    // Save to server via WS
    const ws = (window as unknown as { __gektoWebSocket?: WebSocket }).__gektoWebSocket
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'save_chat',
        agentId: lizardId,
        messages: toSave,
      }))
    }

    // For master: also update client-side serverState so that unmount/remount
    // cycles don't load stale snapshot data (save_chat doesn't broadcast for master)
    if (isMaster && resolvedMasterId) {
      updateLocalAgentMessages(resolvedMasterId, toSave as import('../hooks/useServerState').Message[])
    }
  }, [messages, lizardId, historyLoaded, agent?.taskId, isMaster, resolvedMasterId])

  // Auto-scroll to bottom on new messages or state changes
  const chatMessagesRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!historyLoaded) return
    const el = chatMessagesRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages, historyLoaded, agentState])

  // Scroll to bottom when chat becomes visible (display: none → block)
  useEffect(() => {
    const el = chatMessagesRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      if (el.clientHeight > 0) {
        el.scrollTop = el.scrollHeight
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Resize handlers
  const handleResizeStart = (direction: ResizeDirection) => (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    resizeStart.current = {
      x: e.clientX,
      y: e.clientY,
      width: size.width,
      height: size.height,
    }
    setResizeDirection(direction)
    setIsResizing(true)
  }

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isResizing && resizeDirection) {
        const deltaX = e.clientX - resizeStart.current.x
        const deltaY = e.clientY - resizeStart.current.y

        let newWidth = resizeStart.current.width
        let newHeight = resizeStart.current.height

        // Handle horizontal resize
        if (resizeDirection.includes('e')) {
          newWidth = resizeStart.current.width + deltaX
        } else if (resizeDirection.includes('w')) {
          newWidth = resizeStart.current.width - deltaX
        }

        // Handle vertical resize
        if (resizeDirection.includes('s')) {
          newHeight = resizeStart.current.height + deltaY
        } else if (resizeDirection.includes('n')) {
          newHeight = resizeStart.current.height - deltaY
        }

        const newSize = {
          width: Math.max(minSize.width, newWidth),
          height: Math.max(minSize.height, newHeight),
        }
        setSize(newSize)
        onResize?.(newSize)
      }
    }

    const handleMouseUp = () => {
      if (isResizing) {
        // Save size when resize ends
        saveSizeToStorage(size)
      }
      setIsResizing(false)
      setResizeDirection(null)
    }

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing, resizeDirection, minSize.width, minSize.height, size, onResize])

  const handleSend = () => {
    // Allow sending if ready or queued (will queue on server)
    if ((!inputValue.trim() && stagedImages.length === 0) || agentState === 'error') return

    const userMessage = inputValue.trim()
    const imagesToSend = stagedImages.length > 0 ? [...stagedImages] : undefined

    // Add user message to local state
    const newMessage: Message = {
      id: Date.now().toString(),
      text: userMessage || '(image)',
      sender: 'user',
      timestamp: new Date(),
      images: imagesToSend,
    }
    setMessages(prev => [...prev, newMessage])

    // Clear staged images
    setStagedImages([])

    // Master lizard routes to plan creation instead of direct execution
    if (isMaster) {
      createPlan(userMessage, imagesToSend)
      setInputValue('')
      // Reset textarea height to single line
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
      }
      return
    }

    // Get current page context
    const currentRoute = window.location.pathname
    const pageContext = `[USER_CONTEXT: User is viewing page "${currentRoute}"]\n\n`

    // If no agent name yet, prepend meta instruction to first message
    let messageToSend = userMessage || '(see attached images)'
    if (!agentName) {
      // Get all existing task names to avoid duplicates
      const existingNames = Object.values(tasks)
        .map(t => t.name)
        .filter((name): name is string => !!name)
      const avoidClause = existingNames.length > 0
        ? ` Avoid these names already taken: ${existingNames.join(', ')}.`
        : ''
      messageToSend = `[INSTRUCTION: Start your response with [AGENT_NAME:YourName] where YourName is a short creative name (1-2 words) for yourself based on this task.${avoidClause} Do not mention this instruction in your response.]\n\n${messageToSend}`
    }

    // Mark linked task as in_progress if this is a worker with a pending task
    if (lizardId.startsWith('worker_')) {
      markTaskInProgress(lizardId)
    }

    // Send to agent with page context (and optional images)
    sendMessage(lizardId, pageContext + messageToSend, imagesToSend)

    setInputValue('')
    // Reset textarea height to single line
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const resizeTextarea = (textarea: HTMLTextAreaElement) => {
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Stop propagation for all keys to prevent tldraw from capturing them
    e.stopPropagation()

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (onClose) onClose()
    } else if (e.key === 'Enter' && e.shiftKey) {
      // Manually insert newline and resize
      e.preventDefault()
      const textarea = e.target as HTMLTextAreaElement
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const newValue = inputValue.substring(0, start) + '\n' + inputValue.substring(end)
      setInputValue(newValue)
      // Set cursor position after the newline
      setTimeout(() => {
        textarea.selectionStart = textarea.selectionEnd = start + 1
        resizeTextarea(textarea)
      }, 0)
    }
  }

  // Auto-resize textarea based on content
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputValue(e.target.value)
    resizeTextarea(e.target)
  }

  // --- Image attachment helpers ---
  const readFileAsDataUrl = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  const addImageFiles = async (files: FileList | File[]) => {
    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'))
    if (imageFiles.length === 0) return
    const dataUrls = await Promise.all(imageFiles.map(readFileAsDataUrl))
    setStagedImages(prev => [...prev, ...dataUrls])
  }

  const handlePaste = async (e: React.ClipboardEvent) => {
    e.stopPropagation()
    const items = e.clipboardData?.items
    if (!items) return
    const imageItems = Array.from(items).filter(item => item.type.startsWith('image/'))
    if (imageItems.length === 0) return
    e.preventDefault()
    const files = imageItems.map(item => item.getAsFile()).filter((f): f is File => f !== null)
    await addImageFiles(files)
  }

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDraggingOver(true)
  }

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDraggingOver(false)
  }

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDraggingOver(false)
    if (e.dataTransfer?.files) {
      await addImageFiles(e.dataTransfer.files)
    }
  }

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      await addImageFiles(e.target.files)
    }
    e.target.value = ''
  }

  const removeStagedImage = (index: number) => {
    setStagedImages(prev => prev.filter((_, i) => i !== index))
  }

  // Save current messages to server + client-side state immediately
  const saveMessagesNow = useCallback(() => {
    if (messages.length === 0) return
    const toIso = (v: Date | string): string => v instanceof Date ? v.toISOString() : String(v)
    const toSave = messages.map(m => ({
      id: m.id,
      text: m.text,
      sender: m.sender,
      timestamp: toIso(m.timestamp),
      isTerminal: m.isTerminal,
      isThinking: m.isThinking,
      images: m.images,
      toolUse: m.toolUse ? {
        tool: m.toolUse.tool,
        input: m.toolUse.input,
        fullInput: m.toolUse.fullInput,
        status: m.toolUse.status,
        startTime: toIso(m.toolUse.startTime),
        endTime: m.toolUse.endTime ? toIso(m.toolUse.endTime) : undefined,
      } : undefined,
    }))
    const ws = (window as unknown as { __gektoWebSocket?: WebSocket }).__gektoWebSocket
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'save_chat', agentId: lizardId, messages: toSave }))
    }
    if (isMaster && resolvedMasterId) {
      updateLocalAgentMessages(resolvedMasterId, toSave as import('../hooks/useServerState').Message[])
    }
  }, [messages, lizardId, isMaster, resolvedMasterId])

  const handleStop = useCallback(() => {
    // Save to server, kill, then request fresh state from server (like a restart)
    saveMessagesNow()
    killAgent(lizardId)
    // Clear local state and request fresh snapshot from server
    setMessages([])
    setHistoryLoaded(false)
    const ws = (window as unknown as { __gektoWebSocket?: WebSocket }).__gektoWebSocket
    if (ws && ws.readyState === WebSocket.OPEN) {
      // Small delay to let save_chat persist before requesting snapshot
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'request_snapshot' }))
      }, 200)
    }
  }, [saveMessagesNow, killAgent, lizardId])

  const handlePermissionResponse = (approved: boolean) => {
    respondToPermission(lizardId, approved)
  }

  const handleClearChat = async () => {
    // Archive current session before clearing (only for master with user messages beyond greeting)
    // Skip archiving if this is a restored session (already archived)
    if (isMaster && !isRestoredSession) {
      const hasUserContent = messages.some(m => m.sender === 'user')
      if (hasUserContent) {
        const toIso = (v: Date | string): string => v instanceof Date ? v.toISOString() : String(v)
        const archiveMessages = messages.map(m => ({
          id: m.id,
          text: m.text,
          sender: m.sender,
          timestamp: toIso(m.timestamp),
          isTerminal: m.isTerminal,
          isThinking: m.isThinking,
          images: m.images,
          toolUse: m.toolUse ? {
            tool: m.toolUse.tool,
            input: m.toolUse.input,
            fullInput: m.toolUse.fullInput,
            status: m.toolUse.status,
            startTime: toIso(m.toolUse.startTime),
            endTime: m.toolUse.endTime ? toIso(m.toolUse.endTime) : undefined,
          } : undefined,
        }))

        const ws = (window as unknown as { __gektoWebSocket?: WebSocket }).__gektoWebSocket
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'archive_gekto_session',
            messages: archiveMessages,
            plan: currentPlan,
          }))
        }
      }
    }

    // Reset to default greeting
    const greeting = lizardId === MASTER_ID
      ? `**Hey, I'm Gekto** — your project manager.\n\nI research the codebase, break your request into parallel tasks, and spawn agents to execute them.`
      : 'Hi! How can I help you today?'

    const defaultMessages = [{
      id: '1',
      text: greeting,
      sender: 'bot' as const,
      timestamp: new Date(),
    }]

    setMessages(defaultMessages)

    // Reset the server-side session (clears Claude conversation history)
    resetAgent(lizardId)
    setIsRestoredSession(false)

    // Save cleared state to server via WS
    const ws = (window as unknown as { __gektoWebSocket?: WebSocket }).__gektoWebSocket
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'save_chat',
        agentId: lizardId,
        messages: defaultMessages.map(m => ({
          ...m,
          timestamp: m.timestamp instanceof Date ? m.timestamp.toISOString() : String(m.timestamp),
        })),
      }))
    }

    // Clear plan and text input when clearing master chat
    if (isMaster) {
      cancelPlan()
      setInputValue('')
    }
  }

  // History panel: fetch sessions list and handle restore
  const handleToggleHistory = () => {
    if (showHistory) {
      setShowHistory(false)
      return
    }
    const ws = (window as unknown as { __gektoWebSocket?: WebSocket }).__gektoWebSocket
    if (ws && ws.readyState === WebSocket.OPEN) {
      const handler = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data)
          if (data.type === 'gekto_sessions') {
            setHistorySessions(data.sessions)
            setShowHistory(true)
            ws.removeEventListener('message', handler)
          }
        } catch { /* ignore */ }
      }
      ws.addEventListener('message', handler)
      ws.send(JSON.stringify({ type: 'list_gekto_sessions' }))
      // Timeout cleanup
      setTimeout(() => ws.removeEventListener('message', handler), 3000)
    }
  }

  const handleRestoreSession = (sessionId: string) => {
    const ws = (window as unknown as { __gektoWebSocket?: WebSocket }).__gektoWebSocket
    if (!ws || ws.readyState !== WebSocket.OPEN) return

    const handler = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'session_restored' && data.sessionId === sessionId) {
          ws.removeEventListener('message', handler)
          // Put messages into server state, then update currentMasterId.
          // The resolvedMasterId change triggers the reset effect → loading effect
          // which picks up these messages from serverState.
          if (data.messages) {
            updateLocalAgentMessages(data.currentMasterId, data.messages)
          }
          updateLocalCurrentMasterId(data.currentMasterId)
        }
      } catch { /* ignore */ }
    }
    ws.addEventListener('message', handler)
    setTimeout(() => ws.removeEventListener('message', handler), 5000)

    ws.send(JSON.stringify({ type: 'restore_gekto_session', sessionId }))
    setShowHistory(false)
    setIsRestoredSession(true)
  }

  const handleDeleteSession = (sessionId: string) => {
    const ws = (window as unknown as { __gektoWebSocket?: WebSocket }).__gektoWebSocket
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'delete_gekto_session', sessionId }))
    }
    setHistorySessions(prev => prev.filter(s => s.id !== sessionId))
    setConfirmDeleteId(null)
  }

  // Close history panel on click outside
  useEffect(() => {
    if (!showHistory) return
    const handleClick = (e: globalThis.MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setShowHistory(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showHistory])

  const toggleToolExpanded = (messageId: string) => {
    setExpandedTools(prev => {
      const next = new Set(prev)
      if (next.has(messageId)) {
        next.delete(messageId)
      } else {
        next.add(messageId)
      }
      return next
    })
  }

  const toggleThinkingExpanded = (messageId: string) => {
    setExpandedThinking(prev => {
      const next = new Set(prev)
      if (next.has(messageId)) {
        next.delete(messageId)
      } else {
        next.add(messageId)
      }
      return next
    })
  }

  const formatToolInput = (fullInput: Record<string, unknown>): string => {
    try {
      return JSON.stringify(fullInput, null, 2)
    } catch {
      return String(fullInput)
    }
  }

  // Human-readable tool summary (Claude Code style)
  const formatToolSummary = (tool: string, groupMessages: typeof messages): string => {
    const count = groupMessages.length
    const firstInput = groupMessages[0]?.toolUse?.fullInput as Record<string, unknown> | undefined

    switch (tool) {
      case 'Read': {
        if (count === 1 && firstInput?.file_path) {
          return `Reading ${stripWorkDir(firstInput.file_path as string)}`
        }
        return `Reading ${count} files…`
      }
      case 'Edit': {
        if (count === 1 && firstInput?.file_path) {
          return `Editing ${stripWorkDir(firstInput.file_path as string)}`
        }
        return `Editing ${count} files…`
      }
      case 'Write': {
        if (count === 1 && firstInput?.file_path) {
          return `Writing ${stripWorkDir(firstInput.file_path as string)}`
        }
        return `Writing ${count} files…`
      }
      case 'Grep': {
        if (count === 1 && firstInput?.pattern) {
          return `Searching for "${firstInput.pattern}"…`
        }
        return `Searching for ${count} patterns…`
      }
      case 'Glob': {
        if (count === 1 && firstInput?.pattern) {
          return `Searching for ${firstInput.pattern}…`
        }
        return `Searching for ${count} patterns…`
      }
      case 'Bash': {
        if (count === 1 && firstInput?.command) {
          const cmd = String(firstInput.command)
          const truncated = cmd.length > 60 ? cmd.slice(0, 57) + '…' : cmd
          return `Running \`${truncated}\`…`
        }
        return `Running ${count} commands…`
      }
      case 'Task': {
        if (count === 1) return 'Running task…'
        return `Running ${count} tasks…`
      }
      default: {
        if (count === 1) return tool
        return `${tool} ×${count}`
      }
    }
  }

  // Strip working directory prefix for shorter paths
  const stripWorkDir = (filePath: string): string => {
    // Try common prefixes
    const prefixes = ['/Users/alexey/projects/gekto-swarm/gekto/', '/Users/alexey/projects/gekto-swarm/']
    for (const prefix of prefixes) {
      if (filePath.startsWith(prefix)) {
        return filePath.slice(prefix.length)
      }
    }
    // Fallback: show last 2-3 path segments
    const parts = filePath.split('/')
    if (parts.length > 3) {
      return parts.slice(-3).join('/')
    }
    return filePath
  }

  // Extract short context string from each tool message for tree display
  const getToolPath = (msg: typeof messages[0]): string | null => {
    const input = msg.toolUse?.fullInput as Record<string, unknown> | undefined
    if (!input) return null
    const tool = msg.toolUse?.tool

    switch (tool) {
      case 'Read':
      case 'Edit':
      case 'Write':
        return input.file_path ? stripWorkDir(input.file_path as string) : null
      case 'Grep': {
        const pattern = input.pattern ? `${input.pattern}` : null
        const path = input.path ? ` in ${stripWorkDir(input.path as string)}` : ''
        return pattern ? pattern + path : null
      }
      case 'Glob':
        return input.pattern ? String(input.pattern) : null
      case 'Bash': {
        if (!input.command) return null
        const cmd = String(input.command)
        return cmd.length > 60 ? cmd.slice(0, 57) + '…' : cmd
      }
      default:
        return null
    }
  }

  return (
    <div
      ref={containerRef}
      className="flex flex-col relative"
      style={{
        width: size.width,
        height: size.height,
        background: `linear-gradient(135deg, rgb(35, 35, 45), rgb(45, 45, 55))`,
        backdropFilter: 'blur(12px) saturate(180%)',
        WebkitBackdropFilter: 'blur(12px) saturate(180%)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        borderRadius: 8,
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3"
        style={{
          borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
          cursor: onHeaderMouseDown ? 'grab' : undefined,
        }}
        onMouseDown={onHeaderMouseDown}
      >
        <div className="flex flex-col">
          <div className="flex items-baseline gap-2">
            <span className="text-white font-medium text-sm">{title}</span>
            <span className="text-xs text-white/30">
              {agentState === 'working' ? 'thinking' : agentState === 'queued' ? 'queued' : agentState === 'error' ? 'error' : (isGektoLoading && agentState !== 'ready') ? 'preparing' : ''}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1" onMouseDown={(e) => e.stopPropagation()}>
          {isMaster && false && (
            <div className="relative" ref={historyRef}>
              <button
                onClick={handleToggleHistory}
                className={`text-white/40 hover:text-white/70 transition-colors w-6 h-6 flex items-center justify-center hover:bg-white/10 rounded ${showHistory ? 'text-white/70 bg-white/10' : ''}`}
                title="Chat history"
              >
                <CounterClockwiseClockIcon width={14} height={14} />
              </button>
              {showHistory && (
                <div
                  className="absolute right-0 top-8 z-50 rounded-lg overflow-hidden"
                  style={{
                    width: 280,
                    maxHeight: 320,
                    background: 'rgb(30, 30, 40)',
                    border: '1px solid rgba(255, 255, 255, 0.12)',
                    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                  }}
                >
                  <div className="px-3 py-2 text-xs text-white/50 font-medium" style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                    Chat History
                  </div>
                  <div style={{ maxHeight: 280, overflowY: 'auto' }}>
                    {historySessions.length === 0 && (
                      <div className="px-3 py-4 text-xs text-white/30 text-center">No previous chats</div>
                    )}
                    {historySessions.map(session => (
                      <div
                        key={session.id}
                        className={`relative flex items-center transition-colors ${session.isCurrent ? 'bg-white/5' : 'hover:bg-white/10'}`}
                        style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', height: 44 }}
                      >
                        {confirmDeleteId === session.id ? (
                          <div className="flex items-center gap-2 px-3 py-2 w-full">
                            <span className="text-xs text-white/60 flex-1">Delete this chat?</span>
                            <button
                              onClick={(e) => { e.stopPropagation(); handleDeleteSession(session.id) }}
                              className="text-[10px] text-red-400 hover:text-red-300 px-1.5 py-0.5 rounded hover:bg-red-400/10"
                            >
                              Yes
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null) }}
                              className="text-[10px] text-white/40 hover:text-white/60 px-1.5 py-0.5 rounded hover:bg-white/10"
                            >
                              No
                            </button>
                          </div>
                        ) : (
                          <>
                            <button
                              onClick={() => !session.isCurrent && handleRestoreSession(session.id)}
                              disabled={session.isCurrent}
                              className={`flex-1 text-left px-3 py-2 ${session.isCurrent ? 'cursor-default' : 'cursor-pointer'}`}
                            >
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-white/80 truncate flex-1">
                                  {session.preview}
                                </span>
                                {session.isCurrent && (
                                  <span className="text-[10px] text-green-400/70 shrink-0">current</span>
                                )}
                              </div>
                              <div className="text-[10px] text-white/30 mt-0.5">
                                {session.createdAt ? new Date(session.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}
                                {' · '}{session.messageCount} msgs
                              </div>
                            </button>
                            {!session.isCurrent && (
                              <button
                                onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(session.id) }}
                                className="text-white/15 hover:text-white/40 px-1.5 shrink-0 transition-colors text-[10px]"
                                title="Delete chat"
                              >
                                ✕
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          <button
            onClick={handleClearChat}
            className="text-white/40 hover:text-white/70 transition-colors w-6 h-6 flex items-center justify-center hover:bg-white/10 rounded"
            title="Clear chat"
          >
            <TrashIcon width={14} height={14} />
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="text-white/60 hover:text-white transition-colors w-6 h-6 flex items-center justify-center hover:bg-white/10 rounded"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div
        ref={chatMessagesRef}
        className="chat-messages flex-1 p-4 space-y-3"
        style={{ minHeight: 0, overflowY: 'auto' }}
      >
        {(() => {
          // Group consecutive tool messages by tool name
          const result: Array<{ type: 'message', message: typeof messages[0] } | { type: 'tool-group', tool: string, count: number, ids: string[], messages: typeof messages }> = []
          for (const msg of messages) {
            if (msg.toolUse) {
              const last = result[result.length - 1]
              if (last && last.type === 'tool-group' && last.tool === msg.toolUse.tool) {
                last.count++
                last.ids.push(msg.id)
                last.messages.push(msg)
              } else {
                result.push({ type: 'tool-group', tool: msg.toolUse.tool, count: 1, ids: [msg.id], messages: [msg] })
              }
            } else {
              result.push({ type: 'message', message: msg })
            }
          }
          return result.map((item, idx) => {
            if (item.type === 'tool-group') {
              const groupId = item.ids[0]
              const isLast = idx === result.length - 1
              const isRunning = isLast && agentState === 'working' && !!currentTool && currentTool.tool === item.tool
              const toolSummary = formatToolSummary(item.tool, item.messages)
              const toolPaths = item.messages.map(m => getToolPath(m)).filter((p): p is string => p !== null)
              // Only show paths when there are multiple items (single item info is in the summary)
              const showPaths = item.count > 1 && toolPaths.length > 0
              return (
                <div key={groupId} className="flex justify-start">
                  <div
                    className="max-w-[90%] text-sm cursor-pointer transition-all"
                    onClick={() => toggleToolExpanded(groupId)}
                  >
                    <div className="flex items-center gap-2 py-1">
                      <span
                        style={{
                          color: isRunning ? '#86efac' : 'rgba(255, 255, 255, 0.4)',
                          fontSize: '12px',
                          fontWeight: 700,
                          animation: isRunning ? 'blink-triangle 1.2s ease-in-out infinite' : 'none',
                        }}
                      >
                        ◆
                      </span>
                      <span
                        className={`font-mono text-xs ${isRunning ? 'tool-call-text' : ''}`}
                        style={!isRunning ? { color: 'rgba(255, 255, 255, 0.5)' } : undefined}
                      >
                        {toolSummary}
                      </span>
                    </div>
                    {showPaths && !expandedTools.has(groupId) && (
                      <div className="ml-4 font-mono text-[11px]" style={{ color: 'rgba(255, 255, 255, 0.3)' }}>
                        {toolPaths.map((path, i) => (
                          <div key={i}>
                            <span style={{ color: 'rgba(255, 255, 255, 0.2)' }}>
                              {i === toolPaths.length - 1 ? '└ ' : '├ '}
                            </span>
                            {path}
                          </div>
                        ))}
                      </div>
                    )}
                    {expandedTools.has(groupId) && (
                      <div
                        className="px-3 py-2 font-mono text-xs text-white/70 overflow-auto rounded-lg ml-4 space-y-2"
                        style={{
                          maxHeight: 300,
                          background: 'rgba(0, 0, 0, 0.2)',
                        }}
                      >
                        {item.messages.map(m => (
                          <div key={m.id}>
                            <pre className="whitespace-pre-wrap break-all">
                              {m.toolUse?.fullInput ? formatToolInput(m.toolUse.fullInput) : m.toolUse?.input || m.toolUse?.tool}
                            </pre>
                            {m.toolResult?.content && (
                              <pre
                                className="whitespace-pre-wrap break-all mt-1 pt-1"
                                style={{
                                  color: 'rgba(255, 255, 255, 0.4)',
                                  borderTop: '1px solid rgba(255, 255, 255, 0.08)',
                                  maxHeight: 150,
                                  overflowY: 'auto',
                                }}
                              >
                                {m.toolResult.content}
                              </pre>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )
            }
            const message = item.message

            // Thinking message — rectangle block
            if (message.isThinking) {
              const isActive = !!message.isStreaming
              return (
                <div key={message.id} className="flex justify-start">
                  <div
                    className="max-w-[90%] px-3 py-2 text-sm whitespace-pre-wrap"
                    style={{
                      color: isActive ? 'rgba(255, 255, 255, 0.5)' : 'rgba(255, 255, 255, 0.3)',
                      background: 'rgba(255, 255, 255, 0.03)',
                      border: `1px solid rgba(255, 255, 255, ${isActive ? 0.1 : 0.05})`,
                    }}
                  >
                    {message.text}
                  </div>
                </div>
              )
            }

            return (
          <div
            key={message.id}
            className={`flex ${message.sender === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            {/* System message */}
            {message.sender === 'system' ? (
              <div className="flex items-center gap-2 py-1">
                <span style={{ color: '#4ade80', fontSize: '14px' }}>◆</span>
                <span className="font-mono text-xs" style={{ color: 'rgba(134, 239, 172, 0.6)' }}>{message.text}</span>
              </div>
            ) : (
              /* Regular message */
              <div
                className={`max-w-[90%] px-3 py-2 text-sm whitespace-pre-wrap ${message.sender === 'user' ? 'rounded-lg rounded-br-none rounded-bl-2xl' : 'rounded-xl'}`}
                style={{
                  background: message.isTerminal
                    ? 'rgba(34, 197, 94, 0.15)'
                    : message.sender === 'user'
                      ? 'rgba(255, 255, 255, 0.08)'
                      : 'transparent',
                  color: message.sender === 'user' ? 'rgba(255, 255, 255, 0.7)' : 'rgba(255, 255, 255, 0.8)',
                  border: message.isTerminal
                    ? '1px solid rgba(34, 197, 94, 0.3)'
                    : message.sender === 'user'
                      ? '1px solid rgba(255, 255, 255, 0.1)'
                      : 'none',
                  padding: message.sender === 'bot' && !message.isTerminal ? '0' : undefined,
                }}
              >
                {message.isTerminal && message.sender === 'bot' && (
                  <div className="flex items-center gap-1 mb-1 text-xs text-green-400 opacity-80">
                    <span>⌘</span>
                    <span>terminal</span>
                  </div>
                )}
                {message.images && message.images.length > 0 && (
                  <div className="flex gap-1.5 flex-wrap mb-1">
                    {message.images.map((img, i) => (
                      <img
                        key={i}
                        src={img}
                        alt={`Attachment ${i + 1}`}
                        className="w-16 h-16 object-cover rounded cursor-pointer hover:opacity-80 transition-opacity"
                        style={{ border: '1px solid rgba(255, 255, 255, 0.15)' }}
                        onClick={() => window.open(img, '_blank')}
                      />
                    ))}
                  </div>
                )}
                {message.sender === 'bot' && !message.isTerminal ? (
                  <Markdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      p: ({ children }) => <p className="mb-1 last:mb-0 leading-tight">{children}</p>,
                      code: ({ className, children }) => {
                        const isInline = !className
                        return isInline ? (
                          <code className="bg-white/10 px-1 py-0.5 rounded text-sm">{children}</code>
                        ) : (
                          <code className="block bg-black/30 p-2 rounded text-xs overflow-x-auto my-1">{children}</code>
                        )
                      },
                      pre: ({ children }) => <pre className="overflow-x-auto">{children}</pre>,
                      ul: ({ children }) => <ul className="list-disc list-inside mb-1">{children}</ul>,
                      ol: ({ children }) => <ol className="list-decimal list-inside mb-1">{children}</ol>,
                      li: ({ children }) => <li className="leading-tight">{children}</li>,
                      a: ({ href, children }) => (
                        <a href={href} target="_blank" rel="noopener noreferrer" className="text-green-400 hover:underline">
                          {children}
                        </a>
                      ),
                      strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                      em: ({ children }) => <em className="italic">{children}</em>,
                      h1: ({ children }) => <h1 className="text-sm font-semibold mb-0.5">{children}</h1>,
                      h2: ({ children }) => <h2 className="text-sm font-semibold mb-0.5">{children}</h2>,
                      h3: ({ children }) => <h3 className="text-sm font-semibold mb-0.5">{children}</h3>,
                    }}
                  >
                    {message.text}
                  </Markdown>
                ) : (
                  <span className={message.isTerminal ? 'font-mono text-xs' : ''}>
                    {message.text}
                  </span>
                )}
                {/* Cost/duration metadata */}
                {message.sender === 'bot' && !message.isStreaming && (message.cost != null || message.duration != null) && (
                  <div className="mt-1 font-mono text-[10px]" style={{ color: 'rgba(255, 255, 255, 0.2)' }}>
                    {message.cost != null && `$${message.cost.toFixed(2)}`}
                    {message.cost != null && message.duration != null && ' · '}
                    {message.duration != null && `${Math.round(message.duration / 1000)}s`}
                  </div>
                )}
              </div>
            )}
          </div>
          )})
        })()}

        {/* Quick actions after greeting */}
        {isMaster && messages.length === 1 && messages[0].id === '1' && (
          <div className="flex flex-wrap gap-2 pt-1">
            {[
              'Research the repo',
              'Tell me what you can do',
              'Build a todo app',
            ].map((action) => (
              <button
                key={action}
                className="text-xs px-3 py-1.5 rounded text-white/60 hover:text-white/90 transition-colors cursor-pointer"
                style={{
                  background: 'rgba(255, 255, 255, 0.06)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                }}
                onClick={() => {
                  setInputValue(action)
                  setTimeout(() => textareaRef.current?.focus(), 0)
                }}
              >
                {action}
              </button>
            ))}
          </div>
        )}

        {/* Permission Request */}
        {permissionRequest && (
          <div className="flex justify-start">
            <div
              className="px-3 py-3 rounded-xl text-sm max-w-[90%]"
              style={{
                background: 'rgba(239, 68, 68, 0.15)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                color: 'white',
              }}
            >
              <div className="flex items-center gap-2 mb-2">
                <span>⚠️</span>
                <span className="font-medium">Permission Required</span>
              </div>
              <div className="font-mono text-xs mb-2 opacity-80">
                <span className="text-yellow-400">{permissionRequest.tool}</span>
                {permissionRequest.input && (
                  <span className="opacity-60 ml-1 block truncate">
                    {permissionRequest.input}
                  </span>
                )}
              </div>
              <div className="flex gap-2 mt-3">
                <button
                  onClick={() => handlePermissionResponse(true)}
                  className="px-3 py-1 text-xs font-medium bg-green-600 hover:bg-green-500 transition-colors rounded"
                >
                  Allow
                </button>
                <button
                  onClick={() => handlePermissionResponse(false)}
                  className="px-3 py-1 text-xs font-medium bg-red-600 hover:bg-red-500 transition-colors rounded"
                >
                  Deny
                </button>
              </div>
            </div>
          </div>
        )}

        {agentState === 'working' && !permissionRequest && !currentTool && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 py-1">
              <span style={{ color: '#4ade80', fontSize: '14px', animation: 'blink-triangle 1.2s ease-in-out infinite' }}>◆</span>
              <span className="tool-call-text font-mono text-xs">
                {isMaster ? THINKING_PHRASES[masterPhraseIndex] : AGENT_PHRASES[agentPhraseIndex]}
              </span>
            </div>
          </div>
        )}

        {/* Plan generation loader */}
        {isMaster && currentPlan && (currentPlan.status === 'planning' || currentPlan.status === 'generating_prompts') && agentState !== 'working' && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 py-1">
              <span style={{ color: '#4ade80', fontSize: '14px', animation: 'blink-triangle 1.2s ease-in-out infinite' }}>◆</span>
              <span className="tool-call-text font-mono text-xs">
                {currentPlan.status === 'planning' ? 'Writing plan abstract' : 'Generating tasks'}
              </span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div
        className="chat-input"
        style={{
          borderTop: '1px solid rgba(255, 255, 255, 0.08)',
          background: isDraggingOver ? 'rgba(74, 222, 128, 0.1)' : 'rgba(255, 255, 255, 0.05)',
          transition: 'background 0.15s',
        }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
          {/* Staged image thumbnails */}
          {stagedImages.length > 0 && (
            <div className="flex gap-1.5 px-3 pt-2 flex-wrap">
              {stagedImages.map((img, i) => (
                <div key={i} className="relative group">
                  <img
                    src={img}
                    alt={`Attachment ${i + 1}`}
                    className="w-12 h-12 object-cover rounded"
                    style={{ border: '1px solid rgba(255, 255, 255, 0.15)' }}
                  />
                  <button
                    onClick={() => removeStagedImage(i)}
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 flex items-center justify-center text-[10px] rounded-full bg-black/80 text-white/70 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={(el) => {
              textareaRef.current = el
              if (inputRef) {
                (inputRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el
              }
            }}
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onCopy={(e) => e.stopPropagation()}
            onCut={(e) => e.stopPropagation()}
            placeholder={
              agentState === 'error'
                ? 'Connection error'
                : agentState === 'queued'
                  ? 'Add to queue...'
                  : isDraggingOver
                    ? 'Drop image here...'
                    : 'Type a message...'
            }
            disabled={agentState === 'error'}
            rows={1}
            className="w-full px-3.5 pt-3 pb-1 text-sm text-white placeholder-white/40 outline-none disabled:opacity-50 resize-none"
            style={{
              background: 'transparent',
              border: 'none',
              minHeight: '36px',
              maxHeight: '120px',
              overflow: 'auto',
            }}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={handleFileSelect}
          />
          <div className="flex items-center justify-between px-2 pb-2">
            <div className="flex items-center gap-1 min-w-0 flex-1">
              {isMaster && (
                <div className="flex items-center gap-1">
                  {/* "+" button */}
                  <button
                    onClick={() => {
                      createNewPlan()
                      setTimeout(() => textareaRef.current?.focus(), 50)
                    }}
                    className="flex items-center justify-center px-1.5 py-1 text-xs transition-all hover:bg-white/20 hover:border-white/30 cursor-pointer rounded"
                    style={{
                      background: 'rgba(255, 255, 255, 0.1)',
                      color: 'rgba(255, 255, 255, 0.7)',
                      border: '1px solid rgba(255, 255, 255, 0.15)',
                    }}
                    title="Create new plan"
                  >
                    +
                  </button>
                  {/* "New plan" badge */}
                  {isCreatingNewPlan && (
                    <span
                      className="flex items-center gap-1 px-2 py-1 text-xs rounded"
                      style={{
                        background: 'rgba(74, 222, 128, 0.15)',
                        color: 'rgb(134, 239, 172)',
                        border: '1px solid rgba(74, 222, 128, 0.3)',
                      }}
                    >
                      <FileTextIcon width={12} height={12} />
                      <span>New plan</span>
                    </span>
                  )}
                  {/* "Plans (X)" button with dropdown */}
                  {activePlanCount > 0 && (
                    <div className="relative">
                      <button
                        onClick={() => setShowPlansList(prev => !prev)}
                        className="flex items-center gap-1 px-2 py-1 text-xs transition-all hover:bg-white/20 hover:border-white/30 cursor-pointer rounded"
                        style={{
                          background: 'rgba(255, 255, 255, 0.1)',
                          color: 'rgba(255, 255, 255, 0.7)',
                          border: '1px solid rgba(255, 255, 255, 0.15)',
                        }}
                      >
                        <FileTextIcon width={12} height={12} />
                        <span>Plans ({activePlanCount})</span>
                      </button>
                      {/* Dropdown list — opens upward */}
                      {showPlansList && (
                        <>
                          <div className="fixed inset-0" style={{ zIndex: 9998 }} onClick={() => { setShowPlansList(false); setConfirmDeletePlanId(null) }} />
                          <div
                            className="absolute bottom-full left-0 mb-1 rounded-lg overflow-hidden"
                            style={{
                              background: 'rgb(40, 40, 50)',
                              border: '1px solid rgba(255, 255, 255, 0.12)',
                              zIndex: 9999,
                              boxShadow: '0 -4px 16px rgba(0, 0, 0, 0.4)',
                              minWidth: 200,
                              maxWidth: 300,
                            }}
                          >
                            {Object.values(activePlans)
                              .filter(p => p.status !== 'completed' && p.status !== 'failed')
                              .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
                              .map(plan => {
                                // Count task statuses for this plan
                                const planTaskList = (plan.taskIds || []).map(id => serverState.tasks[id]).filter(Boolean)
                                const running = planTaskList.filter(t => t.status === 'in_progress').length
                                const pendingReview = planTaskList.filter(t => t.status === 'pending_testing').length
                                const waiting = planTaskList.filter(t => t.status === 'pending').length
                                const hasStats = running > 0 || pendingReview > 0 || waiting > 0

                                return (
                                <div
                                  key={plan.id}
                                  className="flex items-center"
                                  style={{
                                    height: 50,
                                    borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
                                  }}
                                >
                                  {confirmDeletePlanId === plan.id ? (
                                    <div className="flex items-center gap-2 px-3 py-2 w-full">
                                      <span className="text-xs text-white/60 flex-1">Delete this plan?</span>
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          selectPlan(plan.id)
                                          cancelPlan()
                                          setConfirmDeletePlanId(null)
                                          if (activePlanCount <= 1) setShowPlansList(false)
                                        }}
                                        className="text-[10px] text-red-400 hover:text-red-300 px-1.5 py-0.5 rounded hover:bg-red-400/10"
                                      >
                                        Yes
                                      </button>
                                      <button
                                        onClick={(e) => { e.stopPropagation(); setConfirmDeletePlanId(null) }}
                                        className="text-[10px] text-white/40 hover:text-white/60 px-1.5 py-0.5 rounded hover:bg-white/10"
                                      >
                                        No
                                      </button>
                                    </div>
                                  ) : (
                                    <div
                                      className="flex items-center gap-2 px-3 py-2 transition-colors hover:bg-white/10 cursor-pointer flex-1 min-w-0"
                                      style={{
                                        color: plan.id === selectedPlanId ? 'rgb(134, 239, 172)' : 'rgba(255, 255, 255, 0.7)',
                                      }}
                                      onClick={() => {
                                        selectPlan(plan.id)
                                        openPlanPanel()
                                        setShowPlansList(false)
                                      }}
                                    >
                                      <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                                        <span className="truncate text-sm">{plan.title || plan.originalPrompt?.slice(0, 40) || plan.id}</span>
                                        {hasStats && (
                                          <div className="flex items-center gap-2 text-[10px]" style={{ color: 'rgba(255, 255, 255, 0.4)' }}>
                                            {running > 0 && (
                                              <span className="flex items-center gap-1">
                                                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: '#facc15' }} />
                                                {running} running
                                              </span>
                                            )}
                                            {pendingReview > 0 && (
                                              <span className="flex items-center gap-1">
                                                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: '#4ade80' }} />
                                                {pendingReview} review
                                              </span>
                                            )}
                                            {waiting > 0 && (
                                              <span className="flex items-center gap-1">
                                                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: '#60a5fa' }} />
                                                {waiting} waiting
                                              </span>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                      <button
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          setConfirmDeletePlanId(plan.id)
                                        }}
                                        className="w-5 h-5 flex items-center justify-center transition-all hover:text-white/80 shrink-0 rounded"
                                        style={{ color: 'rgba(255, 255, 255, 0.3)' }}
                                        title="Remove plan"
                                      >
                                        <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                                          <path d="M2 2l6 6M8 2l-6 6" />
                                        </svg>
                                      </button>
                                    </div>
                                  )}
                                </div>
                              )})}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center justify-center w-6 h-6 text-white/30 hover:text-white/60 transition-colors rounded cursor-pointer"
                title="Attach image"
              >
                <ImageIcon width={16} height={16} />
              </button>
              {agentState === 'working' ? (
                <button
                  onClick={handleStop}
                  className="flex items-center gap-1 px-2 py-1 text-xs transition-all hover:bg-red-500/30 rounded cursor-pointer"
                  style={{
                    background: 'rgba(239, 68, 68, 0.15)',
                    color: 'rgba(239, 68, 68, 0.8)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                  }}
                
                >
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><rect width="8" height="8" rx="1" /></svg>
                  <span>Stop</span>
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={agentState === 'error'}
                  className="px-1.5 py-1 text-white/50 hover:text-white transition-colors disabled:opacity-50 focus:outline-none rounded"
                  style={{
                    background: 'rgba(255, 255, 255, 0.1)',
                    border: '1px solid rgba(255, 255, 255, 0.15)',
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </button>
              )}
            </div>
          </div>
      </div>

      {/* Resize handles */}
      {/* Corners */}
      <div
        className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize"
        style={{
          background: `linear-gradient(135deg, transparent 50%, ${color}44 50%)`,
          borderRadius: 0,
        }}
        onMouseDown={handleResizeStart('se')}
      />
      <div
        className="absolute top-0 right-0 w-3 h-3 cursor-ne-resize"
        style={{ borderRadius: 0 }}
        onMouseDown={handleResizeStart('ne')}
      />
      <div
        className="absolute top-0 left-0 w-3 h-3 cursor-nw-resize"
        style={{ borderRadius: 0 }}
        onMouseDown={handleResizeStart('nw')}
      />
      <div
        className="absolute bottom-0 left-0 w-3 h-3 cursor-sw-resize"
        style={{ borderRadius: 0 }}
        onMouseDown={handleResizeStart('sw')}
      />
      {/* Edges */}
      <div
        className="absolute top-3 bottom-3 right-0 w-1 cursor-e-resize hover:bg-white/10"
        onMouseDown={handleResizeStart('e')}
      />
      <div
        className="absolute top-3 bottom-3 left-0 w-1 cursor-w-resize hover:bg-white/10"
        onMouseDown={handleResizeStart('w')}
      />
      <div
        className="absolute left-3 right-3 top-0 h-1 cursor-n-resize hover:bg-white/10"
        onMouseDown={handleResizeStart('n')}
      />
      <div
        className="absolute left-3 right-3 bottom-0 h-1 cursor-s-resize hover:bg-white/10"
        onMouseDown={handleResizeStart('s')}
      />
    </div>
  )
}