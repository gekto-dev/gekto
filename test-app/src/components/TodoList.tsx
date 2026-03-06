import type { Todo, FilterType } from '../types/todo'
import { TodoItem } from './TodoItem'

interface TodoListProps {
  todos: Todo[]
  filter: FilterType
  setFilter: (filter: FilterType) => void
  onToggle: (id: string) => void
  onDelete: (id: string) => void
}

const filters: FilterType[] = ['all', 'active', 'completed']

export function TodoList({ todos, filter, setFilter, onToggle, onDelete }: TodoListProps) {
  return (
    <div>
      <div
        style={{
          display: 'flex',
          gap: 8,
          marginBottom: 16,
        }}
      >
        {filters.map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            style={{
              padding: '8px 16px',
              fontSize: 14,
              fontWeight: 500,
              background: filter === f ? '#4ade80' : '#1a1a1a',
              border: filter === f ? 'none' : '1px solid #333',
              borderRadius: 6,
              color: filter === f ? '#111' : '#888',
              cursor: 'pointer',
              textTransform: 'capitalize',
            }}
          >
            {f}
          </button>
        ))}
      </div>

      <div>
        {todos.length === 0 ? (
          <p style={{ color: '#666', textAlign: 'center', padding: 24 }}>
            {filter === 'all' ? 'No todos yet. Add one above!' : `No ${filter} todos.`}
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
