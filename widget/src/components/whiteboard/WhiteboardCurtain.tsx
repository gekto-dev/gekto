import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Tldraw, Editor, DefaultToolbar, DefaultContextMenu, DefaultContextMenuContent, TldrawUiMenuItem, TldrawUiMenuGroup, useTools, useIsToolSelected, useEditor, useValue, createShapeId } from 'tldraw'
import { TaskShapeUtil, setOnOpenChat, setOnViewDiff, setOnTitleChange, setOnAccept } from './TaskShape'
import { IframeShapeUtil } from './IframeShape'
import { DiffModal } from './DiffModal'
import { useAgentShapeSync } from './useAgentShapeSync'
import { useStore, type Agent, type Task } from '../../store/store'
import { useSwarm } from '../../context/SwarmContext'
import { useAgent } from '../../context/AgentContext'
import { ChatWindow } from '../ChatWindow'
import { orderFrameElements } from './orderFrameElements'

// Custom shape utils for tldraw
const customShapeUtils = [TaskShapeUtil, IframeShapeUtil]

// Single tool button (hooks must be at component top level)
function ToolButton({ tool }: { tool: ReturnType<typeof useTools>[string] }) {
  const isSelected = useIsToolSelected(tool)
  return <TldrawUiMenuItem {...tool} isSelected={isSelected} />
}

// Custom toolbar with all tldraw tools plus Add Task and Add Iframe
function CustomToolbar({ onAddTask, onAddIframe }: { onAddTask: () => void; onAddIframe: () => void }) {
  const tools = useTools()

  const toolIds = [
    'select', 'hand', 'draw', 'eraser',
    'arrow', 'line', 'text', 'note', 'frame',
    'rectangle', 'ellipse', 'diamond', 'triangle',
    'highlight', 'laser',
  ]

  return (
    <DefaultToolbar>
      {toolIds.map(id => {
        const tool = tools[id]
        if (!tool) return null
        return <ToolButton key={id} tool={tool} />
      })}
      <button
        onClick={onAddTask}
        className="tlui-button tlui-button__tool"
        title="Add Task"
        style={{ color: 'inherit' }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M12 8v8" />
          <path d="M8 12h8" />
        </svg>
      </button>
      <button
        onClick={onAddIframe}
        className="tlui-button tlui-button__tool"
        title="Add Iframe"
        style={{ color: 'inherit' }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      </button>
    </DefaultToolbar>
  )
}

// Custom context menu — adds "Order elements" for frames
function CustomContextMenu() {
  const editor = useEditor()
  const selectedShapes = useValue('selected shapes', () => editor.getSelectedShapes(), [editor])
  const hasFrame = selectedShapes.some(s => s.type === 'frame')

  return (
    <DefaultContextMenu>
      {hasFrame && (
        <TldrawUiMenuGroup id="frame-actions">
          <TldrawUiMenuItem
            id="order-elements"
            label="Order elements"
            onSelect={() => {
              const frames = selectedShapes.filter(s => s.type === 'frame')
              for (const frame of frames) {
                orderFrameElements(editor, frame)
              }
            }}
          />
        </TldrawUiMenuGroup>
      )}
      <DefaultContextMenuContent />
    </DefaultContextMenu>
  )
}

// Floating input below selected frame — uses tldraw's InFrontOfTheCanvas + useValue for reactivity
function SelectedFrameInput() {
  const editor = useEditor()
  const lastFocusedFrameRef = useRef<string | null>(null)

  const info = useValue(
    'selected frame bounds',
    () => {
      const selected = editor.getSelectedShapes()
      if (selected.length !== 1 || selected[0].type !== 'frame') return null
      const shape = selected[0]
      const screenBounds = editor.getViewportScreenBounds()
      const pagePoint = editor.pageToScreen({ x: shape.x, y: shape.y })
      const bounds = editor.getShapeGeometry(shape).bounds
      const zoom = editor.getZoomLevel()
      return {
        id: shape.id,
        x: pagePoint.x - screenBounds.x,
        y: pagePoint.y - screenBounds.y + bounds.h * zoom,
        width: bounds.w * zoom,
      }
    },
    [editor]
  )

  if (!info) {
    lastFocusedFrameRef.current = null
    return null
  }

  return (
    <div
      style={{
        position: 'absolute',
        left: info.x,
        top: info.y + 8,
        width: info.width,
        pointerEvents: 'all',
      }}
      onPointerDown={(e) => {
        e.stopPropagation()
        editor.markEventAsHandled(e.nativeEvent)
      }}
    >
      <div style={{ display: 'flex', gap: 0 }}>
        <input
          ref={() => {
            lastFocusedFrameRef.current = info.id
          }}
          type="text"
          placeholder="Send a message..."
          onKeyDown={(e) => {
            if (e.key === 'Enter' && e.currentTarget.value.trim()) {
              console.log('[FrameInput]', info.id, e.currentTarget.value)
              e.currentTarget.value = ''
            }
            e.stopPropagation()
          }}
          style={{
            flex: 1,
            padding: '8px 12px',
            background: 'rgba(30, 30, 40, 0.95)',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            borderRadius: '8px 0 0 8px',
            color: 'white',
            fontSize: 13,
            outline: 'none',
          }}
        />
        <button
          onClick={(e) => {
            const input = (e.currentTarget.previousSibling as HTMLInputElement)
            if (input?.value.trim()) {
              console.log('[FrameInput]', info.id, input.value)
              input.value = ''
            }
          }}
          style={{
            padding: '8px 10px',
            background: 'rgba(30, 30, 40, 0.95)',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            borderLeft: 'none',
            borderRadius: '0 8px 8px 0',
            color: 'rgba(255, 255, 255, 0.5)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 10l-5 5 5 5" />
            <path d="M20 4v7a4 4 0 0 1-4 4H4" />
          </svg>
        </button>
      </div>
    </div>
  )
}

interface WhiteboardCurtainProps {
  persistenceKey?: string
}

// Export editor ref for programmatic access
export let whiteboardEditor: Editor | null = null

// Export function to open whiteboard from outside
let openWhiteboardFn: (() => void) | null = null
export function openWhiteboard() {
  openWhiteboardFn?.()
}

export function WhiteboardCurtain({ persistenceKey = 'gekto-whiteboard-v2' }: WhiteboardCurtainProps) {
  const { isWhiteboardOpen: isOpen, setWhiteboardOpen } = useSwarm()

  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const editorRef = useRef<Editor | null>(null)

  // Track which agent's chat is open on whiteboard
  const [whiteboardChatAgentId, setWhiteboardChatAgentId] = useState<string | null>(null)
  const [chatPosition, setChatPosition] = useState({ x: 0, y: 0 })

  // Track which agent's diff modal is open
  const [diffAgentId, setDiffAgentId] = useState<string | null>(null)

  // Get sessions, workingDir, and file changes from AgentContext
  const { sessions, getWorkingDir, revertFiles, acceptAgent } = useAgent()
  const workingDir = getWorkingDir()

  // Get agents and tasks from store
  const agents = useStore((s) => s.agents)
  const tasks = useStore((s) => s.tasks)
  const deleteAgent = useStore((s) => s.deleteAgent)
  const createAgent = useStore((s) => s.createAgent)
  const createTask = useStore((s) => s.createTask)
  const updateTask = useStore((s) => s.updateTask)

  // Register the open function in effect
  useEffect(() => {
    openWhiteboardFn = () => setWhiteboardOpen(true)
    return () => { openWhiteboardFn = null }
  }, [setWhiteboardOpen])

  // Register callback for opening chat from TaskShape
  useEffect(() => {
    setOnOpenChat((agentId: string) => {
      // Get shape position from tldraw
      if (editor) {
        const shapes = editor.getCurrentPageShapes()
        const shape = shapes.find(s =>
          (s.type as string) === 'task' &&
          (s as any).props?.agentId === agentId
        )
        if (shape) {
          // Convert page coords to screen coords
          const screenPoint = editor.pageToScreen({ x: shape.x, y: shape.y })
          setChatPosition({
            x: screenPoint.x + 320, // Right of the task
            y: screenPoint.y
          })
        }
      }
      setWhiteboardChatAgentId(agentId)
    })
    return () => setOnOpenChat(null)
  }, [editor])

  // Register callback for viewing diffs from TaskShape
  useEffect(() => {
    setOnViewDiff((agentId: string) => {
      setDiffAgentId(agentId)
    })
    return () => setOnViewDiff(null)
  }, [])

  // Register callback for accepting agent work from TaskShape
  useEffect(() => {
    setOnAccept((agentId: string) => {
      acceptAgent(agentId)
    })
    return () => setOnAccept(null)
  }, [acceptAgent])

  // Register callback for title changes from TaskShape
  useEffect(() => {
    setOnTitleChange((agentId: string, newTitle: string) => {
      // Find the agent and update its task name
      const agent = agents[agentId]
      if (agent?.taskId) {
        updateTask(agent.taskId, { name: newTitle })
      }
    })
    return () => setOnTitleChange(null)
  }, [agents, updateTask])

  // Build agentsWithTasks array for sync hook (exclude master agent)
  const agentsWithTasks = useMemo(() =>
    Object.values(agents)
      .filter(agent => agent.id !== 'master' && !agent.id.startsWith('master_'))
      .map(agent => {
        const session = sessions.get(agent.id)
        return {
          agent,
          task: tasks[agent.taskId],
          currentTool: session?.currentTool?.tool,
          streamingText: session?.streamingText,
          workingDir,
          fileChangeCount: agent.fileChanges?.length ?? 0,
        }
      }),
    [agents, tasks, sessions, workingDir]
  )

  // Restore agent+task on undo (Cmd+Z restores shape after deletion)
  const handleRestoreAgent = useCallback((agent: Agent, task?: Task) => {
    if (task) createTask(task)
    createAgent(agent)
  }, [createTask, createAgent])

  // Sync agents to TaskShapes (Zustand → tldraw)
  // Positions managed by tldraw via persistenceKey
  // When user deletes shape, agent is removed from store
  // When user undoes deletion, agent is restored from buffer
  useAgentShapeSync(editor, agentsWithTasks, deleteAgent, handleRestoreAgent)

  // Setup portal container on mount (preload)
  useEffect(() => {
    const div = document.createElement('div')
    div.id = 'gekto-whiteboard-portal'
    div.style.position = 'relative'
    div.style.zIndex = '500' // Below lizards (1000+)
    document.body.appendChild(div)

    // Inject tldraw CSS
    const styleId = 'tldraw-portal-styles'
    if (!document.getElementById(styleId)) {
      const link = document.createElement('link')
      link.id = styleId
      link.rel = 'stylesheet'
      link.href = 'https://unpkg.com/tldraw@4/tldraw.css'
      document.head.appendChild(link)
    }

    setPortalContainer(div)

    return () => {
      div.remove()
    }
  }, [])

  const handleAddTask = useCallback(() => {
    if (!editor) return

    // Generate unique IDs
    const timestamp = Date.now()
    const taskId = `task_${timestamp}`
    const agentId = `agent_${timestamp}`

    // Count existing agents for naming
    const existingCount = Object.values(agents).filter(a => a.id !== 'master').length

    // Create task in store
    createTask({
      id: taskId,
      name: `New Task ${existingCount + 1}`,
      description: 'Click to add a prompt...',
      prompt: '',
      status: 'pending',
    })

    // Create agent linked to task
    createAgent({
      id: agentId,
      taskId,
      personaId: 'plain',
      status: 'idle',
    })

    // Shape will be created automatically by useAgentShapeSync
  }, [editor, agents, createTask, createAgent])

  const handleAddIframe = useCallback(() => {
    if (!editor) return

    const viewportCenter = editor.getViewportScreenCenter()
    const pageCenter = editor.screenToPage(viewportCenter)

    editor.createShape({
      id: createShapeId(),
      type: 'iframe' as const,
      x: pageCenter.x - 400,
      y: pageCenter.y - 300,
      props: {
        w: 800,
        h: 600,
        url: 'https://claude.ai',
      },
    } as any)
  }, [editor])

  return (
    <>
      {/* Tldraw rendered outside shadow DOM via portal */}
      {portalContainer && createPortal(
        <div
          // @ts-expect-error - inert is a valid HTML attribute
          inert={!isOpen ? '' : undefined}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 500, // Below lizards (1000+)
            background: '#1e1e1e',
            transform: isOpen ? 'translateY(0)' : 'translateY(-100%)',
            transition: 'transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
            pointerEvents: isOpen ? 'auto' : 'none',
          }}
        >
          <Tldraw
            licenseKey="tldraw-2026-05-14/WyJHMEFZeXpDWSIsWyIqIl0sMTYsIjIwMjYtMDUtMTQiXQ.gtnN//75zveJ6yBqHeYuEuV5g65GF4s5QkIkb16gDtE0rxIRAJKZA+szb/bEQDotWSRLuaG8CjlEzXl0lP/Viw"
            persistenceKey={persistenceKey}
            shapeUtils={customShapeUtils}
            onMount={(newEditor) => {
              editorRef.current = newEditor
              whiteboardEditor = newEditor
              setEditor(newEditor)
              newEditor.user.updateUserPreferences({ colorScheme: 'dark' })
            }}
            components={{
              Toolbar: () => <CustomToolbar onAddTask={handleAddTask} onAddIframe={handleAddIframe} />,
              ContextMenu: CustomContextMenu,
              InFrontOfTheCanvas: SelectedFrameInput,
              ActionsMenu: null,
              HelpMenu: null,
              NavigationPanel: null,
              PageMenu: null,
              DebugMenu: null,
              DebugPanel: null,
            }}
          />

        </div>,
        portalContainer
      )}

      {/* Chat overlay - rendered in shadow DOM with high z-index to appear above whiteboard */}
      {whiteboardChatAgentId && (
        <div
          className="fixed"
          style={{
            left: chatPosition.x,
            top: chatPosition.y,
            zIndex: 100000,
            pointerEvents: 'auto',
          }}
        >
          <ChatWindow
            lizardId={whiteboardChatAgentId}
            title="Agent Chat"
            onClose={() => setWhiteboardChatAgentId(null)}
          />
        </div>
      )}

      {/* Diff modal - rendered in portal to appear above tldraw */}
      {diffAgentId && portalContainer && createPortal(
        <DiffModal
          fileChanges={agents[diffAgentId]?.fileChanges ?? []}
          onClose={() => setDiffAgentId(null)}
          onRevertFile={(filePath) => {
            revertFiles(diffAgentId, [filePath])
          }}
          onRevertAll={() => {
            const changes = agents[diffAgentId]?.fileChanges ?? []
            revertFiles(diffAgentId, changes.map(fc => fc.filePath))
            setDiffAgentId(null)
          }}
          onAcceptAll={() => {
            acceptAgent(diffAgentId)
            setDiffAgentId(null)
          }}
        />,
        portalContainer
      )}

    </>
  )
}

export default WhiteboardCurtain
