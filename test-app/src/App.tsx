import { useState } from 'react';
import './index.css';
import { Todo, List, FilterType, Priority } from './types';
import { AddTodo } from './components/AddTodo';
import TodoList from './components/TodoList';
import TodoFilter from './components/TodoFilter';
import { ListSelector } from './components/ListSelector';

const initialLists: List[] = [
  { id: 'work', name: 'Work' },
  { id: 'personal', name: 'Personal' },
];

const initialTodos: Todo[] = [
  {
    id: '1',
    text: 'Review quarterly report',
    completed: false,
    createdAt: new Date('2026-03-10'),
    priority: 'high',
    dueDate: '2026-03-14', // overdue
    listId: 'work',
  },
  {
    id: '2',
    text: 'Schedule team meeting',
    completed: true,
    createdAt: new Date('2026-03-12'),
    priority: 'medium',
    dueDate: '2026-03-20',
    listId: 'work',
  },
  {
    id: '3',
    text: 'Update project documentation',
    completed: false,
    createdAt: new Date('2026-03-14'),
    priority: 'low',
    dueDate: '2026-03-25',
    listId: 'work',
  },
  {
    id: '4',
    text: 'Buy groceries',
    completed: false,
    createdAt: new Date('2026-03-15'),
    priority: 'medium',
    dueDate: '2026-03-17',
    listId: 'personal',
  },
  {
    id: '5',
    text: 'Call mom',
    completed: false,
    createdAt: new Date('2026-03-13'),
    priority: 'high',
    dueDate: '2026-03-10', // overdue
    listId: 'personal',
  },
];

export default function App() {
  const [todos, setTodos] = useState<Todo[]>(initialTodos);
  const [lists, setLists] = useState<List[]>(initialLists);
  const [activeListId, setActiveListId] = useState<string>('work');
  const [filter, setFilter] = useState<FilterType>('all');

  const addTodo = (text: string, priority: Priority, dueDate?: string) => {
    const newTodo: Todo = {
      id: crypto.randomUUID(),
      text,
      completed: false,
      createdAt: new Date(),
      priority,
      dueDate,
      listId: activeListId,
    };
    setTodos([...todos, newTodo]);
  };

  const toggleTodo = (id: string) => {
    setTodos(
      todos.map((todo) =>
        todo.id === id ? { ...todo, completed: !todo.completed } : todo
      )
    );
  };

  const deleteTodo = (id: string) => {
    setTodos(todos.filter((todo) => todo.id !== id));
  };

  const addList = (name: string) => {
    const newList: List = {
      id: crypto.randomUUID(),
      name,
    };
    setLists([...lists, newList]);
    setActiveListId(newList.id);
  };

  // Derived filtered todos: first by list, then by filter type
  const filteredTodos = todos
    .filter((todo) => todo.listId === activeListId)
    .filter((todo) => {
      if (filter === 'active') return !todo.completed;
      if (filter === 'completed') return todo.completed;
      return true; // 'all'
    });

  return (
    <div className="app-layout">
      <ListSelector
        lists={lists}
        activeListId={activeListId}
        onSelectList={setActiveListId}
        onAddList={addList}
      />
      <main className="app">
        <h1>Todo List</h1>
        <AddTodo onAdd={addTodo} />
        <TodoFilter currentFilter={filter} onFilterChange={setFilter} />
        <TodoList
          todos={filteredTodos}
          onToggle={toggleTodo}
          onDelete={deleteTodo}
        />
      </main>
    </div>
  );
}
