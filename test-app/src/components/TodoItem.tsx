import { Priority, Todo } from '../types';

interface TodoItemProps {
  todo: Todo;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
}

function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function isOverdue(dueDate: Date, completed: boolean): boolean {
  if (completed) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate);
  due.setHours(0, 0, 0, 0);
  return due < today;
}

export function TodoItem({ todo, onToggle, onDelete }: TodoItemProps) {
  const formattedCreatedAt = todo.createdAt.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  const priority: Priority = todo.priority || 'low';

  const dueDateObj = todo.dueDate ? new Date(todo.dueDate) : null;
  const formattedDueDate = dueDateObj
    ? dueDateObj.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : null;
  const overdueClass = dueDateObj && isOverdue(dueDateObj, todo.completed) ? ' overdue' : '';

  return (
    <li className={`todo-item${todo.completed ? ' completed' : ''}`}>
      <input
        type="checkbox"
        checked={todo.completed}
        onChange={() => onToggle(todo.id)}
      />
      <span className={`todo-text${todo.completed ? ' completed' : ''}`}>
        {todo.text}
      </span>
      <span className={`priority-badge priority-${priority}`}>
        {capitalizeFirst(priority)}
      </span>
      {formattedDueDate && (
        <span className={`due-date${overdueClass}`}>
          {formattedDueDate}
        </span>
      )}
      <span className="todo-date">{formattedCreatedAt}</span>
      <button className="delete-btn" onClick={() => onDelete(todo.id)}>Delete</button>
    </li>
  );
}
