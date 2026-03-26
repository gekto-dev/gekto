import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TodoList from './TodoList';
import { Todo } from '../types';

describe('TodoList', () => {
  const createMockTodo = (overrides: Partial<Todo> = {}): Todo => ({
    id: '1',
    text: 'Test todo',
    completed: false,
    createdAt: new Date('2026-01-15'),
    ...overrides,
  });

  it('renders all todo texts when given a non-empty array', () => {
    const todos: Todo[] = [
      createMockTodo({ id: '1', text: 'First todo' }),
      createMockTodo({ id: '2', text: 'Second todo' }),
      createMockTodo({ id: '3', text: 'Third todo' }),
    ];
    const onToggle = vi.fn();
    const onDelete = vi.fn();

    render(<TodoList todos={todos} onToggle={onToggle} onDelete={onDelete} />);

    expect(screen.getByText('First todo')).toBeInTheDocument();
    expect(screen.getByText('Second todo')).toBeInTheDocument();
    expect(screen.getByText('Third todo')).toBeInTheDocument();
  });

  it('renders an empty list when todos is an empty array', () => {
    const onToggle = vi.fn();
    const onDelete = vi.fn();

    render(<TodoList todos={[]} onToggle={onToggle} onDelete={onDelete} />);

    const list = screen.getByRole('list');
    expect(list).toBeInTheDocument();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('calls onToggle with the correct todo id when checkbox is clicked', async () => {
    const user = userEvent.setup();
    const todos: Todo[] = [createMockTodo({ id: 'todo-123', text: 'Toggle me' })];
    const onToggle = vi.fn();
    const onDelete = vi.fn();

    render(<TodoList todos={todos} onToggle={onToggle} onDelete={onDelete} />);

    const checkbox = screen.getByRole('checkbox');
    await user.click(checkbox);

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith('todo-123');
  });

  it('calls onDelete with the correct todo id when delete button is clicked', async () => {
    const user = userEvent.setup();
    const todos: Todo[] = [createMockTodo({ id: 'todo-456', text: 'Delete me' })];
    const onToggle = vi.fn();
    const onDelete = vi.fn();

    render(<TodoList todos={todos} onToggle={onToggle} onDelete={onDelete} />);

    const deleteButton = screen.getByRole('button', { name: /delete/i });
    await user.click(deleteButton);

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith('todo-456');
  });

  it('renders multiple todos with independently wired handlers', async () => {
    const user = userEvent.setup();
    const todos: Todo[] = [
      createMockTodo({ id: 'first-id', text: 'First item' }),
      createMockTodo({ id: 'second-id', text: 'Second item' }),
    ];
    const onToggle = vi.fn();
    const onDelete = vi.fn();

    render(<TodoList todos={todos} onToggle={onToggle} onDelete={onDelete} />);

    const checkboxes = screen.getAllByRole('checkbox');
    const deleteButtons = screen.getAllByRole('button', { name: /delete/i });

    expect(checkboxes).toHaveLength(2);
    expect(deleteButtons).toHaveLength(2);

    // Click the second item's checkbox
    await user.click(checkboxes[1]);
    expect(onToggle).toHaveBeenCalledWith('second-id');

    // Click the first item's delete button
    await user.click(deleteButtons[0]);
    expect(onDelete).toHaveBeenCalledWith('first-id');

    // Verify each handler was called once
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
