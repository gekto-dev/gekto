import type { Todo } from '../types/todo'

interface GroupedTaskListProps {
  todos: Todo[]
  onToggle: (id: string) => void
  onDelete: (id: string) => void
  onSelectTask: (todo: Todo) => void
  selectedTaskId?: string
  onClearCompleted: () => void
  completedCount: number
  title?: string
  onAddTaskClick?: () => void
}

type DateGroup = 'Today' | 'Tomorrow' | 'This Week' | 'Later' | 'No Date'

function getDateGroup(dueDate: string | undefined): DateGroup {
  if (!dueDate) {
    return 'No Date'
  }

  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const due = new Date(dueDate)
  due.setHours(0, 0, 0, 0)

  const diffTime = due.getTime() - today.getTime()
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))

  if (diffDays === 0) {
    return 'Today'
  } else if (diffDays === 1) {
    return 'Tomorrow'
  } else if (diffDays > 1 && diffDays <= 7) {
    return 'This Week'
  } else {
    return 'Later'
  }
}

function groupTodosByDate(todos: Todo[]): Record<DateGroup, Todo[]> {
  const groups: Record<DateGroup, Todo[]> = {
    'Today': [],
    'Tomorrow': [],
    'This Week': [],
    'Later': [],
    'No Date': [],
  }

  for (const todo of todos) {
    const group = getDateGroup(todo.dueDate)
    groups[group].push(todo)
  }

  return groups
}

function formatTime(dueDate: string): string | null {
  const date = new Date(dueDate)
  const hours = date.getHours()
  const minutes = date.getMinutes()

  // If time is midnight (00:00), assume no specific time was set
  if (hours === 0 && minutes === 0) {
    return null
  }

  const ampm = hours >= 12 ? 'PM' : 'AM'
  const hour12 = hours % 12 || 12
  const minuteStr = minutes.toString().padStart(2, '0')

  return `${hour12}:${minuteStr} ${ampm}`
}

function getTimeBadgeColor(dueDate: string): string {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const due = new Date(dueDate)
  due.setHours(0, 0, 0, 0)

  const diffTime = due.getTime() - today.getTime()
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))

  if (diffDays < 0) {
    return '#ef4444' // overdue - red
  } else if (diffDays === 0) {
    return '#4ade80' // today - green
  } else {
    return '#888' // future - gray
  }
}

const GROUP_ORDER: DateGroup[] = ['Today', 'Tomorrow', 'This Week', 'Later', 'No Date']

export function GroupedTaskList({
  todos,
  onToggle,
  onDelete,
  onSelectTask,
  selectedTaskId,
  onClearCompleted,
  completedCount,
  title = 'Tasks',
  onAddTaskClick,
}: GroupedTaskListProps) {
  const groupedTodos = groupTodosByDate(todos)

  return (
    <div>
      {/* Header bar */}
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 10,
          background: '#1e1e1e',
          padding: '12px 16px',
          borderRadius: 8,
          marginBottom: 12,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <h2
          style={{
            margin: 0,
            fontSize: 18,
            fontWeight: 600,
            color: '#e0e0e0',
          }}
        >
          {title}
        </h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {completedCount > 0 && (
            <button
              onClick={onClearCompleted}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#666',
                cursor: 'pointer',
                fontSize: 13,
                padding: '4px 8px',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = '#888')}
              onMouseLeave={(e) => (e.currentTarget.style.color = '#666')}
            >
              Clear completed ({completedCount})
            </button>
          )}
          <span
            style={{
              background: '#2a2a2a',
              color: '#888',
              fontSize: 13,
              fontWeight: 500,
              padding: '4px 10px',
              borderRadius: 12,
            }}
          >
            {todos.length}
          </span>
        </div>
      </div>

      {/* Add Task button row */}
      {onAddTaskClick && (
        <div
          onClick={onAddTaskClick}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '12px 16px',
            background: 'transparent',
            borderRadius: 8,
            marginBottom: 16,
            cursor: 'pointer',
            transition: 'background 0.15s ease',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = '#252525')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <span
            style={{
              width: 20,
              height: 20,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#4ade80',
              fontSize: 20,
              fontWeight: 300,
            }}
          >
            +
          </span>
          <span style={{ color: '#666', fontSize: 15 }}>Add Task</span>
        </div>
      )}

      {/* Task list */}
      <div>
        {todos.length === 0 ? (
          <p style={{ color: '#666', textAlign: 'center', padding: 24 }}>
            No tasks to display
          </p>
        ) : (
          GROUP_ORDER.map(group => {
            const groupTodos = groupedTodos[group]
            if (groupTodos.length === 0) {
              return null
            }

            return (
              <div key={group} style={{ marginBottom: 20 }}>
                <h3
                  style={{
                    fontSize: 12,
                    textTransform: 'uppercase',
                    color: '#888',
                    marginBottom: 12,
                    fontWeight: 600,
                    letterSpacing: '0.5px',
                  }}
                >
                  {group}
                </h3>
                {groupTodos.map(todo => {
                  const isSelected = todo.id === selectedTaskId
                  const timeStr = todo.dueDate ? formatTime(todo.dueDate) : null
                  const badgeColor = todo.dueDate ? getTimeBadgeColor(todo.dueDate) : '#888'

                  return (
                    <div
                      key={todo.id}
                      onClick={() => onSelectTask(todo)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '12px 16px',
                        background: '#252525',
                        borderRadius: 8,
                        marginBottom: 8,
                        cursor: 'pointer',
                        border: isSelected ? '2px solid #4ade80' : '2px solid transparent',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={todo.completed}
                        onChange={(e) => {
                          e.stopPropagation()
                          onToggle(todo.id)
                        }}
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          width: 20,
                          height: 20,
                          cursor: 'pointer',
                          accentColor: '#4ade80',
                        }}
                      />
                      <span
                        style={{
                          flex: 1,
                          color: todo.completed ? '#666' : '#e0e0e0',
                          textDecoration: todo.completed ? 'line-through' : 'none',
                          fontSize: 16,
                        }}
                      >
                        {todo.text}
                      </span>
                      {timeStr && (
                        <span
                          style={{
                            background: '#2a2a2a',
                            color: badgeColor,
                            fontSize: 12,
                            fontWeight: 500,
                            padding: '3px 8px',
                            borderRadius: 4,
                          }}
                        >
                          {timeStr}
                        </span>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          onDelete(todo.id)
                        }}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: '#ef4444',
                          cursor: 'pointer',
                          fontSize: 18,
                          padding: '4px 8px',
                          borderRadius: 4,
                        }}
                      >
                        ×
                      </button>
                    </div>
                  )
                })}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
