import type { Todo, FilterType, SortType } from '../types/todo'
import { TodoItem } from './TodoItem'

interface TodoListProps {
  todos: Todo[]
  filter: FilterType
  setFilter: (filter: FilterType) => void
  sort: SortType
  setSort: (sort: SortType) => void
  onToggle: (id: string) => void
  onDelete: (id: string) => void
}

const filters: FilterType[] = ['all', 'active', 'completed']
const sorts: SortType[] = ['newest', 'oldest']

export function TodoList({ todos, filter, setFilter, sort, setSort, onToggle, onDelete }: TodoListProps) {
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

        <div
          style={{
            width: 1,
            background: '#333',
            margin: '0 8px',
          }}
        />

        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortType)}
          style={{
            background: '#1a1a1a',
            color: '#888',
            border: '1px solid #333',
            borderRadius: 6,
            padding: '8px 16px',
            fontSize: 14,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          {sorts.map(s => (
            <option key={s} value={s} style={{ textTransform: 'capitalize' }}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
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
