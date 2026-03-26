import * as React from 'react'
import {
  ShapeUtil,
  Rectangle2d,
  HTMLContainer,
  resizeBox,
  T,
} from 'tldraw'
import type { TLBaseShape, TLResizeInfo } from 'tldraw'

// Global callback for opening chat - set by WhiteboardCurtain
let onOpenChatCallback: ((agentId: string) => void) | null = null

export function setOnOpenChat(callback: ((agentId: string) => void) | null) {
  onOpenChatCallback = callback
}

// Global callback for viewing diffs - set by WhiteboardCurtain
let onViewDiffCallback: ((agentId: string) => void) | null = null

export function setOnViewDiff(callback: ((agentId: string) => void) | null) {
  onViewDiffCallback = callback
}

// Global callback for title changes - set by WhiteboardCurtain
let onTitleChangeCallback: ((agentId: string, newTitle: string) => void) | null = null

export function setOnTitleChange(callback: ((agentId: string, newTitle: string) => void) | null) {
  onTitleChangeCallback = callback
}

// Global callback for accepting (completing) an agent's work - set by WhiteboardCurtain
let onAcceptCallback: ((agentId: string) => void) | null = null

export function setOnAccept(callback: ((agentId: string) => void) | null) {
  onAcceptCallback = callback
}

// Define the status type for agent activities
export type TaskStatus = 'READ' | 'WRITE' | 'BASH' | 'GREP' | 'EDIT' | 'done' | 'error' | 'pending' | 'idle'

// Define the shape type
export type TaskShape = TLBaseShape<
  'task',
  {
    w: number
    h: number
    title: string
    abstract: string         // Summary of work done
    branch?: string          // Worktree branch name (optional)
    status: TaskStatus
    message?: string         // Bottom zone for errors/results
    agentId?: string         // Link to agent in AgentStore
    workingDir?: string      // Agent's root location
    fileChangeCount?: number // Number of files changed by this agent
  }
>

// Props validator for tldraw - all props must be JSON serializable
const taskShapeProps = {
  w: T.number,
  h: T.number,
  title: T.string,
  abstract: T.string,
  branch: T.string.optional(),
  status: T.literalEnum('READ', 'WRITE', 'BASH', 'GREP', 'EDIT', 'done', 'error', 'pending', 'idle'),
  message: T.string.optional(),
  agentId: T.string.optional(),
  workingDir: T.string.optional(),
  fileChangeCount: T.number.optional(),
}

const DEFAULT_HEIGHT = 200

// Editable title component with double-click to edit
function EditableTitle({
  title,
  agentId,
  onOpenChat
}: {
  title: string
  agentId?: string
  onOpenChat: () => void
}) {
  const [isEditing, setIsEditing] = React.useState(false)
  const [editValue, setEditValue] = React.useState(title)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  // Sync editValue when title prop changes (from external updates)
  React.useEffect(() => {
    if (!isEditing) {
      setEditValue(title)
    }
  }, [title, isEditing])

  const handleSave = () => {
    setIsEditing(false)
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== title && agentId && onTitleChangeCallback) {
      onTitleChangeCallback(agentId, trimmed)
    } else {
      setEditValue(title) // Reset if empty or unchanged
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      handleSave()
    } else if (e.key === 'Escape') {
      setEditValue(title)
      setIsEditing(false)
    }
  }

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={handleSave}
        onKeyDown={handleKeyDown}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        style={{
          flex: 1,
          fontSize: 20,
          fontWeight: 600,
          color: '#ffffff',
          background: 'rgba(255,255,255,0.1)',
          border: '1px solid rgba(255,255,255,0.3)',
          borderRadius: 4,
          padding: '2px 6px',
          outline: 'none',
          minWidth: 0,
          fontFamily: 'inherit',
        }}
      />
    )
  }

  return (
    <div
      onPointerDown={(e) => {
        e.stopPropagation()
        e.preventDefault()
        onOpenChat()
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        e.preventDefault()
        if (agentId) {
          setIsEditing(true)
        }
      }}
      style={{
        flex: 1,
        fontSize: 20,
        fontWeight: 600,
        color: '#ffffff',
        cursor: agentId ? 'pointer' : 'default',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
      onMouseEnter={(e) => {
        if (agentId) e.currentTarget.style.textDecoration = 'underline'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.textDecoration = 'none'
      }}
      title="Click to chat, double-click to edit"
    >
      {title || 'Untitled Task'}
    </div>
  )
}

// Inject spinner animation CSS (only once)
if (typeof document !== 'undefined' && !document.getElementById('task-shape-styles')) {
  const style = document.createElement('style')
  style.id = 'task-shape-styles'
  style.textContent = `
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }
  `
  document.head.appendChild(style)
}

// Base colors (matching ChatWindow theme)
const BASE_COLORS = {
  bg: 'linear-gradient(135deg, rgb(35, 35, 45), rgb(45, 45, 55))',
  bgFlat: 'rgb(40, 40, 50)',
  border: 'rgba(255, 255, 255, 0.08)',
  text: '#e5e5e5',
  textMuted: 'rgba(255, 255, 255, 0.5)',
}

// Status-based accent colors
const STATUS_COLORS: Record<TaskStatus, { accent: string; label: string }> = {
  // Running tools - blue accent
  READ: { accent: '#3b82f6', label: 'READ' },
  WRITE: { accent: '#3b82f6', label: 'WRITE' },
  BASH: { accent: '#3b82f6', label: 'BASH' },
  GREP: { accent: '#3b82f6', label: 'GREP' },
  EDIT: { accent: '#3b82f6', label: 'EDIT' },
  // Completion states
  done: { accent: '#22c55e', label: 'DONE' },
  error: { accent: '#ef4444', label: 'ERROR' },
  pending: { accent: '#f59e0b', label: 'PENDING' },
  idle: { accent: '#6b7280', label: 'IDLE' },
}

// Using 'any' for generic to work around tldraw's strict built-in shape types
export class TaskShapeUtil extends ShapeUtil<any> {
  static override type = 'task' as const
  static override props = taskShapeProps

  getDefaultProps(): TaskShape['props'] {
    return {
      w: 300,
      h: DEFAULT_HEIGHT,
      title: 'New Task',
      abstract: '',
      status: 'pending',
    }
  }

  getGeometry(shape: TaskShape) {
    return new Rectangle2d({
      width: shape.props.w,
      height: shape.props.h,
      isFilled: true,
    })
  }

  canResize() {
    return true
  }

  canEdit() {
    return true
  }

  override onResize(shape: TaskShape, info: TLResizeInfo<any>) {
    return resizeBox(shape as any, info as any)
  }


  component(shape: TaskShape) {
    const { w, h, title, abstract, branch, status, message, agentId, workingDir, fileChangeCount } = shape.props
    const statusInfo = STATUS_COLORS[status]
    const isRunning = ['READ', 'WRITE', 'BASH', 'GREP', 'EDIT'].includes(status)
    const hasFileChanges = (fileChangeCount ?? 0) > 0

    const handleOpenChat = () => {
      if (agentId && onOpenChatCallback) {
        onOpenChatCallback(agentId)
      }
    }

    const handleDiffClick = (e: React.PointerEvent) => {
      e.stopPropagation()
      e.preventDefault()
      if (agentId && onViewDiffCallback) {
        onViewDiffCallback(agentId)
      }
    }

    const handleAcceptClick = (e: React.PointerEvent) => {
      e.stopPropagation()
      e.preventDefault()
      if (agentId && onAcceptCallback) {
        onAcceptCallback(agentId)
      }
    }

    return (
      <HTMLContainer
        style={{
          width: w,
          height: h,
          pointerEvents: 'all',
        }}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            background: BASE_COLORS.bg,
            border: `1px solid ${BASE_COLORS.border}`,
            borderRadius: 8,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          }}
        >
          {/* Header: Title + Status Badge */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: branch ? '10px 12px 4px' : '10px 12px',
              borderBottom: branch ? 'none' : `1px solid ${BASE_COLORS.border}`,
            }}
          >
            {/* Title - clickable to open chat, double-click to edit */}
            <EditableTitle
              title={title}
              agentId={agentId}
              onOpenChat={handleOpenChat}
            />

            {/* Status Badge - hidden when idle */}
            {status !== 'idle' && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '4px 10px',
                  borderRadius: 5,
                  background: statusInfo.accent + '20',
                  color: statusInfo.accent,
                  fontSize: 14,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.5px',
                  flexShrink: 0,
                  animation: isRunning ? 'pulse 1.5s ease-in-out infinite' : 'none',
                }}
              >
                {isRunning && (
                  <div
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: '50%',
                      border: `2px solid ${statusInfo.accent}`,
                      borderTopColor: 'transparent',
                      animation: 'spin 0.8s linear infinite',
                    }}
                  />
                )}
                {statusInfo.label}
              </span>
            )}
          </div>

          {/* Branch (optional) - directly under header */}
          {branch && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '0 12px 6px',
                borderBottom: `1px solid ${BASE_COLORS.border}`,
                fontSize: 12,
                color: BASE_COLORS.textMuted,
              }}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="6" y1="3" x2="6" y2="15" />
                <circle cx="18" cy="6" r="3" />
                <circle cx="6" cy="18" r="3" />
                <path d="M18 9a9 9 0 0 1-9 9" />
              </svg>
              <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>{branch}</span>
            </div>
          )}
          
          {/* Summary: Current work status */}
          <div style={{ flex: 1, padding: '8px 12px', overflow: 'auto' }}>
            <textarea
              readOnly
              value={abstract}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="Agent is free and waiting for instructions..."
              style={{
                width: '100%',
                height: '100%',
                border: 'none',
                background: 'transparent',
                fontSize: 13,
                color: BASE_COLORS.textMuted,
                outline: 'none',
                resize: 'none',
                fontFamily: 'inherit',
                lineHeight: 1.4,
              }}
            />
          </div>

          {/* Dynamic Block: Errors only */}
          {message && status === 'error' && (
            <DynamicBlock status={status} message={message} />
          )}

          {/* Footer: Working directory + Diff button */}
          {(workingDir || hasFileChanges) && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '6px 12px',
                borderTop: `1px solid ${BASE_COLORS.border}`,
                background: 'rgba(0, 0, 0, 0.2)',
                fontSize: 11,
                color: BASE_COLORS.textMuted,
              }}
            >
              <span
                style={{
                  fontFamily: 'ui-monospace, monospace',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                }}
                title={workingDir}
              >
                {workingDir ? workingDir.split('/').slice(-2).join('/') : ''}
              </span>
              {/* Diff button - shows when there are file changes */}
              {hasFileChanges && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 8 }}>
                  <div
                    onPointerDown={handleDiffClick}
                    onPointerEnter={(e) => { e.currentTarget.style.textDecoration = 'underline' }}
                    onPointerLeave={(e) => { e.currentTarget.style.textDecoration = 'none' }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 3,
                      padding: '3px 6px',
                      borderRadius: 4,
                      background: 'transparent',
                      color: 'rgba(255,255,255,0.9)',
                      cursor: 'pointer',
                      fontWeight: 500,
                      fontSize: 10,
                    }}
                  >
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 3v18" />
                      <path d="M3 12h18" />
                    </svg>
                    {fileChangeCount} {fileChangeCount === 1 ? 'file' : 'files'}
                  </div>
                  {/* Accept button */}
                  <div
                    onPointerDown={handleAcceptClick}
                    onPointerEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.18)' }}
                    onPointerLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.10)' }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 3,
                      padding: '3px 8px',
                      borderRadius: 4,
                      background: 'rgba(255,255,255,0.10)',
                      color: 'rgba(255,255,255,0.9)',
                      cursor: 'pointer',
                      fontWeight: 500,
                      fontSize: 10,
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    Accept
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: TaskShape) {
    return (
      <rect
        width={shape.props.w}
        height={shape.props.h}
        rx={8}
        ry={8}
      />
    )
  }
}

// Dynamic block for actions, errors, or results
function DynamicBlock({ status, message }: { status: TaskStatus; message: string }) {
  const isError = status === 'error'
  const isDone = status === 'done'
  const isAction = message.startsWith('action:')

  // Parse action message format: "action:label:description"
  const actionParts = isAction ? message.split(':') : null
  const actionLabel = actionParts?.[1] || 'Approve'
  const actionDesc = actionParts?.[2] || ''

  if (isAction) {
    return (
      <div
        style={{
          padding: '8px 12px',
          borderTop: `1px solid ${BASE_COLORS.border}`,
          background: '#3b82f610',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span style={{ flex: 1, fontSize: 12, color: BASE_COLORS.textMuted }}>
          {actionDesc || 'Action required'}
        </span>
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          style={{
            padding: '4px 12px',
            border: 'none',
            background: '#3b82f6',
            color: '#fff',
            fontSize: 11,
            fontWeight: 500,
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          {actionLabel}
        </button>
      </div>
    )
  }

  if (isDone) {
    return (
      <div
        style={{
          padding: '8px 12px',
          borderTop: `1px solid ${BASE_COLORS.border}`,
          background: '#22c55e10',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
          color: '#22c55e',
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        <span style={{ fontFamily: 'ui-monospace, monospace' }}>{message}</span>
      </div>
    )
  }

  if (isError) {
    return (
      <div
        style={{
          padding: '8px 12px',
          borderTop: `1px solid ${BASE_COLORS.border}`,
          background: '#ef444410',
          fontSize: 12,
          color: '#ef4444',
          lineHeight: 1.4,
        }}
      >
        {message}
      </div>
    )
  }

  // Default: info message (for running states)
  return (
    <div
      style={{
        padding: '8px 12px',
        borderTop: `1px solid ${BASE_COLORS.border}`,
        background: '#3b82f608',
        fontSize: 12,
        color: BASE_COLORS.textMuted,
        lineHeight: 1.4,
      }}
    >
      {message}
    </div>
  )
}
