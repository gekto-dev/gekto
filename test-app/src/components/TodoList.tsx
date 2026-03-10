import type { Todo } from '../types/todo'
import { TodoItem } from './TodoItem'

interface TodoListProps {
  todos: Todo[]
  onToggle: (id: string) => void
  onDelete: (id: string) => void
  onClearCompleted: () => void
  completedCount: number
}

export function TodoList({ todos, onToggle, onDelete, onClearCompleted, completedCount }: TodoListProps) {
  return (
    <div>
      {completedCount > 0 && (
        <div style={{ marginBottom: 16, textAlign: 'right' }}>
          <button
            onClick={onClearCompleted}
            style={{
              padding: '8px 16px',
              fontSize: 14,
              fontWeight: 500,
              background: 'transparent',
              border: '1px solid #333',
              borderRadius: 6,
              color: '#888',
              cursor: 'pointer',
            }}
          >
            Clear completed ({completedCount})
          </button>
        </div>
      )}

      <div>
        {todos.length === 0 ? (
          <p style={{ color: '#666', textAlign: 'center', padding: 24 }}>
            No todos to display.
          </p>
        ) : (
          todos.map(todo => (
            <TodoItem
              key={todo.id}
              todo={todo}
              onToggle={onToggle}
              onDelete={onDelete}
            />
          ))
        )}
      </div>
    </div>
  )
}
