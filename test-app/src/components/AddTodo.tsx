import { useState } from 'react';
import { Priority } from '../types';

interface AddTodoProps {
  onAdd: (text: string, priority: Priority, dueDate?: string) => void;
}

export function AddTodo({ onAdd }: AddTodoProps) {
  const [value, setValue] = useState<string>('');
  const [priority, setPriority] = useState<Priority>('medium');
  const [dueDate, setDueDate] = useState<string>('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (trimmed) {
      onAdd(trimmed, priority, dueDate || undefined);
      setValue('');
      setPriority('medium');
      setDueDate('');
    }
  };

  return (
    <form className="add-todo" onSubmit={handleSubmit}>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Add a new todo..."
      />
      <select
        value={priority}
        onChange={(e) => setPriority(e.target.value as Priority)}
      >
        <option value="high">High</option>
        <option value="medium">Medium</option>
        <option value="low">Low</option>
      </select>
      <input
        type="date"
        value={dueDate}
        onChange={(e) => setDueDate(e.target.value)}
      />
      <button type="submit">Add</button>
    </form>
  );
}
