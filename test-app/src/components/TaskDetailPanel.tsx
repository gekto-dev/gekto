import { useState, useEffect, KeyboardEvent } from 'react'

// Local types (not imported from other files)
interface Subtask {
  id: string
  text: string
  completed: boolean
}

interface Task {
  id: string
  text: string
  completed: boolean
  createdAt: number
  dueDate?: string
  notes?: string
  listId?: string
  subtasks?: Subtask[]
}

interface TaskDetailPanelProps {
  task: Task | null
  onClose: () => void
  onUpdateTask: (task: Task) => void
  onAddSubtask: (parentId: string, text: string) => void
  onToggleSubtask: (parentId: string, subtaskId: string) => void
  onDeleteSubtask: (parentId: string, subtaskId: string) => void
}

export function TaskDetailPanel({
  task,
  onClose,
  onUpdateTask,
  onAddSubtask,
  onToggleSubtask,
  onDeleteSubtask,
}: TaskDetailPanelProps) {
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [newSubtaskText, setNewSubtaskText] = useState('')

  // Sync local state when task changes
  useEffect(() => {
    if (task) {
      setTitle(task.text)
      setNotes(task.notes || '')
      setDueDate(task.dueDate || '')
    }
  }, [task])

  // Handle null task - show empty state
  if (!task) {
    return (
      <div
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#888',
          fontSize: 14,
        }}
      >
        Select a task to view details
      </div>
    )
  }

  const handleTitleBlur = () => {
    if (title.trim() && title !== task.text) {
      onUpdateTask({ ...task, text: title.trim() })
    }
  }

  const handleTitleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.currentTarget.blur()
    }
  }

  const handleNotesBlur = () => {
    if (notes !== (task.notes || '')) {
      onUpdateTask({ ...task, notes: notes || undefined })
    }
  }

  const handleNotesKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && e.metaKey) {
      e.currentTarget.blur()
    }
  }

  const handleDueDateChange = (value: string) => {
    setDueDate(value)
    onUpdateTask({ ...task, dueDate: value || undefined })
  }

  const handleAddSubtask = () => {
    const text = newSubtaskText.trim()
    if (text) {
      onAddSubtask(task.id, text)
      setNewSubtaskText('')
    }
  }

  const handleSubtaskKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleAddSubtask()
    }
  }

  const formatDate = (timestamp: number): string => {
    const date = new Date(timestamp)
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const subtasks = task.subtasks || []

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: '#0d0d0d',
        borderLeft: '1px solid #222',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '16px 20px',
          borderBottom: '1px solid #222',
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: 16,
            fontWeight: 600,
            color: '#e0e0e0',
          }}
        >
          Task Details
        </h2>
        <button
          onClick={onClose}
          style={{
            background: 'transparent',
            border: 'none',
            color: '#888',
            cursor: 'pointer',
            fontSize: 20,
            padding: '4px 8px',
            borderRadius: 4,
            lineHeight: 1,
          }}
          aria-label="Close panel"
        >
          &times;
        </button>
      </div>

      {/* Content */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 20,
        }}
      >
        {/* Title Input */}
        <div style={{ marginBottom: 20 }}>
          <label
            style={{
              display: 'block',
              fontSize: 12,
              color: '#888',
              marginBottom: 6,
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
            }}
          >
            Title
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={handleTitleBlur}
            onKeyDown={handleTitleKeyDown}
            style={{
              width: '100%',
              padding: '10px 12px',
              fontSize: 14,
              background: '#1a1a1a',
              border: '1px solid #333',
              borderRadius: 6,
              color: '#e0e0e0',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Notes Textarea */}
        <div style={{ marginBottom: 20 }}>
          <label
            style={{
              display: 'block',
              fontSize: 12,
              color: '#888',
              marginBottom: 6,
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
            }}
          >
            Notes
          </label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={handleNotesBlur}
            onKeyDown={handleNotesKeyDown}
            placeholder="Add notes..."
            rows={4}
            style={{
              width: '100%',
              padding: '10px 12px',
              fontSize: 14,
              background: '#1a1a1a',
              border: '1px solid #333',
              borderRadius: 6,
              color: '#e0e0e0',
              outline: 'none',
              resize: 'vertical',
              fontFamily: 'inherit',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Due Date Input */}
        <div style={{ marginBottom: 20 }}>
          <label
            style={{
              display: 'block',
              fontSize: 12,
              color: '#888',
              marginBottom: 6,
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
            }}
          >
            Due Date
          </label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => handleDueDateChange(e.target.value)}
            style={{
              width: '100%',
              padding: '10px 12px',
              fontSize: 14,
              background: '#1a1a1a',
              border: '1px solid #333',
              borderRadius: 6,
              color: dueDate ? '#e0e0e0' : '#888',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Subtasks Section */}
        <div style={{ marginBottom: 20 }}>
          <label
            style={{
              display: 'block',
              fontSize: 12,
              color: '#888',
              marginBottom: 10,
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
            }}
          >
            Subtasks ({subtasks.length})
          </label>

          {/* Subtasks List */}
          {subtasks.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              {subtasks.map((subtask) => (
                <div
                  key={subtask.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 10px',
                    background: '#1a1a1a',
                    borderRadius: 6,
                    marginBottom: 6,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={subtask.completed}
                    onChange={() => onToggleSubtask(task.id, subtask.id)}
                    style={{
                      width: 16,
                      height: 16,
                      cursor: 'pointer',
                      accentColor: '#4ade80',
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      flex: 1,
                      fontSize: 14,
                      color: subtask.completed ? '#666' : '#e0e0e0',
                      textDecoration: subtask.completed ? 'line-through' : 'none',
                    }}
                  >
                    {subtask.text}
                  </span>
                  <button
                    onClick={() => onDeleteSubtask(task.id, subtask.id)}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: '#ef4444',
                      cursor: 'pointer',
                      fontSize: 14,
                      padding: '2px 6px',
                      borderRadius: 4,
                      lineHeight: 1,
                      flexShrink: 0,
                    }}
                    aria-label={`Delete subtask: ${subtask.text}`}
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Add Subtask Input */}
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              value={newSubtaskText}
              onChange={(e) => setNewSubtaskText(e.target.value)}
              onKeyDown={handleSubtaskKeyDown}
              placeholder="Add a subtask..."
              style={{
                flex: 1,
                padding: '8px 10px',
                fontSize: 14,
                background: '#1a1a1a',
                border: '1px solid #333',
                borderRadius: 6,
                color: '#e0e0e0',
                outline: 'none',
              }}
            />
            <button
              onClick={handleAddSubtask}
              disabled={!newSubtaskText.trim()}
              style={{
                padding: '8px 14px',
                fontSize: 14,
                fontWeight: 500,
                background: newSubtaskText.trim() ? '#4ade80' : '#333',
                border: 'none',
                borderRadius: 6,
                color: newSubtaskText.trim() ? '#111' : '#666',
                cursor: newSubtaskText.trim() ? 'pointer' : 'not-allowed',
              }}
            >
              Add
            </button>
          </div>
        </div>

        {/* Creation Date */}
        <div
          style={{
            paddingTop: 16,
            borderTop: '1px solid #222',
          }}
        >
          <span
            style={{
              fontSize: 12,
              color: '#666',
            }}
          >
            Created: {formatDate(task.createdAt)}
          </span>
        </div>
      </div>
    </div>
  )
}
