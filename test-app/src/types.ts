export type Priority = 'high' | 'medium' | 'low';

export interface Todo {
  id: string;
  text: string;
  completed: boolean;
  createdAt: Date;
  priority?: Priority;
  dueDate?: string;
  listId?: string;
}

export interface List {
  id: string;
  name: string;
}

export type FilterType = 'all' | 'active' | 'completed';
