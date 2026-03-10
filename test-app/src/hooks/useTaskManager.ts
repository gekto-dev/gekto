import { useState, useMemo } from 'react'

// Types defined inline as required
export interface Subtask {
  id: string
  text: string
  completed: boolean
}

export interface Task {
  id: string
  text: string
  completed: boolean
  createdAt: number
  dueDate?: string
  subtasks: Subtask[]
  listId: string
  priority?: 'low' | 'medium' | 'high'
  notes?: string
}

export interface TaskList {
  id: string
  name: string
  color: string
}

export type QuickFilter = 'all' | 'today' | 'upcoming' | 'completed'

const INBOX_LIST: TaskList = {
  id: 'inbox',
  name: 'Inbox',
  color: '#3b82f6',
}

function getTodayDate(): string {
  return new Date().toISOString().split('T')[0]
}

export function useTaskManager() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [lists, setLists] = useState<TaskList[]>([INBOX_LIST])
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [activeListId, setActiveListId] = useState<string | null>(null)
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all')

  // Task operations
  const addTask = (text: string, listId?: string, dueDate?: string) => {
    if (!text.trim()) return
    const newTask: Task = {
      id: crypto.randomUUID(),
      text: text.trim(),
      completed: false,
      createdAt: Date.now(),
      dueDate,
      subtasks: [],
      listId: listId ?? 'inbox',
    }
    setTasks(prev => [newTask, ...prev])
  }

  const updateTask = (id: string, updates: Partial<Task>) => {
    setTasks(prev =>
      prev.map(task =>
        task.id === id ? { ...task, ...updates } : task
      )
    )
  }

  const deleteTask = (id: string) => {
    setTasks(prev => prev.filter(task => task.id !== id))
    if (selectedTaskId === id) {
      setSelectedTaskId(null)
    }
  }

  const toggleTask = (id: string) => {
    setTasks(prev =>
      prev.map(task =>
        task.id === id ? { ...task, completed: !task.completed } : task
      )
    )
  }

  // Subtask operations
  const addSubtask = (taskId: string, text: string) => {
    if (!text.trim()) return
    const newSubtask: Subtask = {
      id: crypto.randomUUID(),
      text: text.trim(),
      completed: false,
    }
    setTasks(prev =>
      prev.map(task =>
        task.id === taskId
          ? { ...task, subtasks: [...task.subtasks, newSubtask] }
          : task
      )
    )
  }

  const toggleSubtask = (taskId: string, subtaskId: string) => {
    setTasks(prev =>
      prev.map(task =>
        task.id === taskId
          ? {
              ...task,
              subtasks: task.subtasks.map(st =>
                st.id === subtaskId ? { ...st, completed: !st.completed } : st
              ),
            }
          : task
      )
    )
  }

  const deleteSubtask = (taskId: string, subtaskId: string) => {
    setTasks(prev =>
      prev.map(task =>
        task.id === taskId
          ? { ...task, subtasks: task.subtasks.filter(st => st.id !== subtaskId) }
          : task
      )
    )
  }

  // List operations
  const addList = (name: string, color: string) => {
    if (!name.trim()) return
    const newList: TaskList = {
      id: crypto.randomUUID(),
      name: name.trim(),
      color,
    }
    setLists(prev => [...prev, newList])
  }

  const deleteList = (id: string) => {
    if (id === 'inbox') return // Cannot delete inbox
    // Reassign tasks from deleted list to inbox
    setTasks(prev =>
      prev.map(task =>
        task.listId === id ? { ...task, listId: 'inbox' } : task
      )
    )
    setLists(prev => prev.filter(list => list.id !== id))
    if (activeListId === id) {
      setActiveListId(null)
    }
  }

  // Selection operations
  const selectTask = (id: string | null) => {
    setSelectedTaskId(id)
  }

  // Computed values
  const filteredTasks = useMemo(() => {
    const today = getTodayDate()

    let filtered = tasks

    // Apply list filter
    if (activeListId !== null) {
      filtered = filtered.filter(task => task.listId === activeListId)
    }

    // Apply quick filter
    switch (quickFilter) {
      case 'today':
        filtered = filtered.filter(task => task.dueDate === today)
        break
      case 'upcoming':
        filtered = filtered.filter(task => task.dueDate && task.dueDate > today)
        break
      case 'completed':
        filtered = filtered.filter(task => task.completed)
        break
      case 'all':
      default:
        // No additional filtering
        break
    }

    // Sort by dueDate (nulls last), then by createdAt (newest first)
    return [...filtered].sort((a, b) => {
      // First sort by dueDate
      if (a.dueDate && b.dueDate) {
        if (a.dueDate !== b.dueDate) {
          return a.dueDate.localeCompare(b.dueDate)
        }
      } else if (a.dueDate && !b.dueDate) {
        return -1
      } else if (!a.dueDate && b.dueDate) {
        return 1
      }
      // Then sort by createdAt (newest first)
      return b.createdAt - a.createdAt
    })
  }, [tasks, activeListId, quickFilter])

  const selectedTask = useMemo(() => {
    if (!selectedTaskId) return null
    return tasks.find(task => task.id === selectedTaskId) ?? null
  }, [tasks, selectedTaskId])

  const taskCounts = useMemo(() => {
    const today = getTodayDate()
    return {
      total: tasks.length,
      today: tasks.filter(task => task.dueDate === today).length,
      upcoming: tasks.filter(task => task.dueDate && task.dueDate > today).length,
      completed: tasks.filter(task => task.completed).length,
    }
  }, [tasks])

  return {
    // State
    tasks,
    lists,
    selectedTaskId,
    activeListId,
    quickFilter,
    // Task operations
    addTask,
    updateTask,
    deleteTask,
    toggleTask,
    // Subtask operations
    addSubtask,
    toggleSubtask,
    deleteSubtask,
    // List operations
    addList,
    deleteList,
    // Selection and filtering
    selectTask,
    setActiveList: setActiveListId,
    setQuickFilter,
    // Computed values
    filteredTasks,
    selectedTask,
    taskCounts,
  }
}
