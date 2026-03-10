export interface Subtask {
  id: string
  text: string
  completed: boolean
}

export interface Todo {
  id: string
  text: string
  completed: boolean
  createdAt: number
  dueDate?: string
  subtasks?: Subtask[]
  listId?: string
  priority?: 'low' | 'medium' | 'high'
  notes?: string
}

export interface TaskList {
  id: string
  name: string
  color?: string
  icon?: string
}

export type FilterType = 'all' | 'active' | 'completed' | 'today' | 'upcoming'

export type SortType = 'newest' | 'oldest'
