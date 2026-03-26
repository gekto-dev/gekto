import { render, screen, fireEvent } from '@testing-library/react';
import { TodoItem } from './TodoItem';

describe('TodoItem', () => {
  const baseTodo = {
    id: '1',
    text: 'Test Todo',
    completed: false,
    createdAt: new Date('2026-03-15'),
  };

  it('renders todo text correctly', () => {
    const onToggle = vi.fn();
    const onDelete = vi.fn();

    render(<TodoItem todo={baseTodo} onToggle={onToggle} onDelete={onDelete} />);

    expect(screen.getByText('Test Todo')).toBeInTheDocument();
  });

  it('renders the formatted creation date', () => {
    const onToggle = vi.fn();
    const onDelete = vi.fn();

    render(<TodoItem todo={baseTodo} onToggle={onToggle} onDelete={onDelete} />);

    expect(screen.getByText('Mar 15, 2026')).toBeInTheDocument();
  });

  it('checkbox is unchecked when todo.completed is false', () => {
    const onToggle = vi.fn();
    const onDelete = vi.fn();

    render(<TodoItem todo={baseTodo} onToggle={onToggle} onDelete={onDelete} />);

    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).not.toBeChecked();
  });

  it('checkbox is checked when todo.completed is true', () => {
    const onToggle = vi.fn();
    const onDelete = vi.fn();
    const completedTodo = { ...baseTodo, completed: true };

    render(<TodoItem todo={completedTodo} onToggle={onToggle} onDelete={onDelete} />);

    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toBeChecked();
  });

  it('clicking the checkbox calls onToggle with the todo id', () => {
    const onToggle = vi.fn();
    const onDelete = vi.fn();

    render(<TodoItem todo={baseTodo} onToggle={onToggle} onDelete={onDelete} />);

    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith('1');
  });

  it('clicking the Delete button calls onDelete with the todo id', () => {
    const onToggle = vi.fn();
    const onDelete = vi.fn();

    render(<TodoItem todo={baseTodo} onToggle={onToggle} onDelete={onDelete} />);

    const deleteButton = screen.getByRole('button', { name: 'Delete' });
    fireEvent.click(deleteButton);

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith('1');
  });

  it('text element has completed class when todo.completed is true', () => {
    const onToggle = vi.fn();
    const onDelete = vi.fn();
    const completedTodo = { ...baseTodo, completed: true };

    render(<TodoItem todo={completedTodo} onToggle={onToggle} onDelete={onDelete} />);

    const textElement = screen.getByText('Test Todo');
    expect(textElement).toHaveClass('completed');
  });

  it('text element does not have completed class when todo.completed is false', () => {
    const onToggle = vi.fn();
    const onDelete = vi.fn();

    render(<TodoItem todo={baseTodo} onToggle={onToggle} onDelete={onDelete} />);

    const textElement = screen.getByText('Test Todo');
    expect(textElement).not.toHaveClass('completed');
  });
});
