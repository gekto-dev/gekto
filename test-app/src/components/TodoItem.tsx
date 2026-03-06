import type { Todo } from '../types/todo'

interface TodoItemProps {
  todo: Todo
  onToggle: (id: string) => void
  onDelete: (id: string) => void
}

export function TodoItem({ todo, onToggle, onDelete }: TodoItemProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 16px',
        background: '#1a1a1a',
        borderRadius: 8,
        marginBottom: 8,
      }}
    >
      <input
        type="checkbox"
        checked={todo.completed}
        onChange={() => onToggle(todo.id)}
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
      <button
        onClick={() => onDelete(todo.id)}
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
        x
      </button>
    </div>
  )
}
