import { useTodos } from './hooks/useTodos'
import { TodoInput } from './components/TodoInput'
import { TodoList } from './components/TodoList'

function App() {
  const { todos, addTodo, toggleTodo, deleteTodo, filter, setFilter, sort, setSort } = useTodos()

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column' as const,
        justifyContent: 'center',
        alignItems: 'center',
        height: '100vh',
        background: '#111',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Animated glow orbs */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'radial-gradient(ellipse at 30% 50%, rgba(34, 197, 94, 0.06) 0%, transparent 60%), radial-gradient(ellipse at 70% 50%, rgba(134, 239, 172, 0.04) 0%, transparent 50%)',
          animation: 'bg-drift 12s ease-in-out infinite',
        }}
      />
      {/* Subtle grid overlay */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: 'linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)',
          backgroundSize: '60px 60px',
        }}
      />
      <h1
        style={{
          fontSize: 80,
          fontWeight: 600,
          letterSpacing: '-0.02em',
          position: 'relative',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          background: 'linear-gradient(135deg, rgba(255,255,255,0.9) 0%, rgba(134,239,172,0.7) 50%, rgba(255,255,255,0.9) 100%)',
          backgroundSize: '200% auto',
          WebkitBackgroundClip: 'text',
          backgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          animation: 'gekto-shine 6s ease-in-out infinite',
        }}
      >
        Gekto
      </h1>
      <p
        style={{
          position: 'relative',
          fontSize: 24,
          fontWeight: 400,
          letterSpacing: '0.15em',
          color: 'rgba(255, 255, 255, 0.25)',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          marginTop: -48,
        }}
      >
        Playground
      </p>

      {/* Todo section */}
      <div
        style={{
          position: 'relative',
          maxWidth: 500,
          width: '100%',
          margin: '48px auto 0',
          padding: '0 20px',
        }}
      >
        <TodoInput onAdd={addTodo} />
        <TodoList
          todos={todos}
          onToggle={toggleTodo}
          onDelete={deleteTodo}
          filter={filter}
          setFilter={setFilter}
          sort={sort}
          setSort={setSort}
        />
      </div>
    </div>
  )
}

export default App
