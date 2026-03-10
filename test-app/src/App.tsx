import { useState } from 'react'
import { useTaskManager, Task } from './hooks/useTaskManager'
import { Layout } from './components/Layout'
import { Sidebar } from './components/Sidebar'
import { TodoInput } from './components/TodoInput'
import { GroupedTaskList } from './components/GroupedTaskList'
import { TaskDetailPanel } from './components/TaskDetailPanel'

// Adapt between QuickFilter ('all' | 'today' | 'upcoming' | 'completed') and Sidebar's FilterType
type FilterType = 'all' | 'active' | 'completed' | 'today' | 'upcoming'
type SortType = 'newest' | 'oldest' | 'dueDate'

function App() {
  const {
    tasks,
    lists,
    filteredTasks,
    selectedTask,
    selectedTaskId,
    selectTask,
    activeListId,
    setActiveList,
    quickFilter,
    setQuickFilter,
    taskCounts,
    // Task operations
    addTask,
    updateTask,
    deleteTask,
    toggleTask,
    // Subtask operations
    addSubtask,
    toggleSubtask,
    deleteSubtask,
  } = useTaskManager()

  // Local sort state (useTaskManager handles sorting internally, but Sidebar expects this)
  const [sort, setSort] = useState<SortType>('newest')

  // Map quickFilter to FilterType for Sidebar compatibility
  const filter: FilterType = quickFilter === 'all' ? 'all'
    : quickFilter === 'today' ? 'today'
    : quickFilter === 'upcoming' ? 'upcoming'
    : quickFilter === 'completed' ? 'completed'
    : 'all'

  const handleSetFilter = (f: FilterType) => {
    // Map FilterType back to QuickFilter
    if (f === 'active') {
      // 'active' means non-completed - treat as 'all' since useTaskManager doesn't have 'active'
      setQuickFilter('all')
    } else {
      setQuickFilter(f as 'all' | 'today' | 'upcoming' | 'completed')
    }
  }

  // Compute counts for Sidebar
  const counts = {
    total: taskCounts.total,
    active: taskCounts.total - taskCounts.completed,
    completed: taskCounts.completed,
    today: taskCounts.today,
    upcoming: taskCounts.upcoming,
  }

  // Build lists with counts for Sidebar
  const listsWithCounts = lists.map(list => ({
    ...list,
    count: tasks.filter(t => t.listId === list.id).length,
  }))

  // Clear completed tasks
  const clearCompleted = () => {
    tasks.filter(t => t.completed).forEach(t => deleteTask(t.id))
  }

  // Handle task selection
  const handleSelectTask = (todo: { id: string }) => {
    selectTask(todo.id)
  }

  // Handle task update from detail panel
  const handleUpdateTask = (updatedTask: Task) => {
    updateTask(updatedTask.id, updatedTask)
  }

  // Close detail panel
  const handleClosePanel = () => {
    selectTask(null)
  }

  return (
    <Layout
      sidebar={
        <Sidebar
          filter={filter}
          setFilter={handleSetFilter}
          sort={sort}
          setSort={setSort}
          lists={listsWithCounts}
          activeListId={activeListId}
          setActiveListId={setActiveList}
          counts={counts}
        />
      }
      rightPanel={
        <TaskDetailPanel
          task={selectedTask}
          onClose={handleClosePanel}
          onUpdateTask={handleUpdateTask}
          onAddSubtask={addSubtask}
          onToggleSubtask={toggleSubtask}
          onDeleteSubtask={deleteSubtask}
        />
      }
    >
      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: 48 }}>
        <h1
          style={{
            fontSize: 64,
            fontWeight: 600,
            letterSpacing: '-0.02em',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            background: 'linear-gradient(135deg, rgba(255,255,255,0.9) 0%, rgba(134,239,172,0.7) 50%, rgba(255,255,255,0.9) 100%)',
            backgroundSize: '200% auto',
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            animation: 'gekto-shine 6s ease-in-out infinite',
            margin: 0,
            lineHeight: 1.1,
          }}
        >
          Gekto
        </h1>
        <p
          style={{
            fontSize: 18,
            fontWeight: 400,
            letterSpacing: '0.15em',
            color: 'rgba(255, 255, 255, 0.25)',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            margin: '8px 0 0 0',
          }}
        >
          Playground
        </p>
      </div>

      {/* Task section */}
      <div
        style={{
          maxWidth: 500,
          width: '100%',
        }}
      >
        <TodoInput onAdd={(text) => addTask(text)} />
        <GroupedTaskList
          todos={filteredTasks}
          onToggle={toggleTask}
          onDelete={deleteTask}
          onSelectTask={handleSelectTask}
          selectedTaskId={selectedTaskId ?? undefined}
          onClearCompleted={clearCompleted}
          completedCount={counts.completed}
        />
      </div>
    </Layout>
  )
}

export default App
