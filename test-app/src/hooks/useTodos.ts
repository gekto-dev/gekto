import { useState, useMemo } from 'react'
import type { Todo, FilterType } from '../types/todo'

type SortType = 'newest' | 'oldest'

export function useTodos() {
  const [todos, setTodos] = useState<Todo[]>([])
  const [filter, setFilter] = useState<FilterType>('all')
  const [sort, setSort] = useState<SortType>('newest')

  const addTodo = (text: string, dueDate?: string) => {
    if (!text.trim()) return
    const newTodo: Todo = {
      id: crypto.randomUUID(),
      text: text.trim(),
      completed: false,
      createdAt: Date.now(),
      dueDate,
    }
    setTodos(prev => [newTodo, ...prev])
  }

  const toggleTodo = (id: string) => {
    setTodos(prev =>
      prev.map(todo =>
        todo.id === id ? { ...todo, completed: !todo.completed } : todo
      )
    )
  }

  const deleteTodo = (id: string) => {
    setTodos(prev => prev.filter(todo => todo.id !== id))
  }

  const clearCompleted = () => {
    setTodos(prev => prev.filter(todo => !todo.completed))
  }

  const counts = useMemo(() => ({
    total: todos.length,
    active: todos.filter(t => !t.completed).length,
    completed: todos.filter(t => t.completed).length,
  }), [todos])

  const filteredTodos = useMemo(() => {
    let filtered: Todo[]
    switch (filter) {
      case 'active':
        filtered = todos.filter(todo => !todo.completed)
        break
      case 'completed':
        filtered = todos.filter(todo => todo.completed)
        break
      default:
        filtered = todos
    }

    return [...filtered].sort((a, b) => {
      return sort === 'newest'
        ? b.createdAt - a.createdAt
        : a.createdAt - b.createdAt
    })
  }, [todos, filter, sort])

  return {
    todos: filteredTodos,
    addTodo,
    toggleTodo,
    deleteTodo,
    clearCompleted,
    filter,
    setFilter,
    sort,
    setSort,
    counts,
  }
}
