import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddTodo } from './AddTodo';

describe('AddTodo', () => {
  it('renders an input and a submit button', () => {
    const onAdd = vi.fn();
    render(<AddTodo onAdd={onAdd} />);

    expect(screen.getByPlaceholderText('Add a new todo...')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
  });

  it('typing into the input updates its displayed value', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(<AddTodo onAdd={onAdd} />);

    const input = screen.getByPlaceholderText('Add a new todo...');
    await user.type(input, 'Buy groceries');

    expect(input).toHaveValue('Buy groceries');
  });

  it('submitting with text calls onAdd with the trimmed text', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(<AddTodo onAdd={onAdd} />);

    const input = screen.getByPlaceholderText('Add a new todo...');
    const button = screen.getByRole('button', { name: 'Add' });

    await user.type(input, '  Buy groceries  ');
    await user.click(button);

    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith('Buy groceries');
  });

  it('input is cleared after a successful submit', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(<AddTodo onAdd={onAdd} />);

    const input = screen.getByPlaceholderText('Add a new todo...');
    const button = screen.getByRole('button', { name: 'Add' });

    await user.type(input, 'Buy groceries');
    await user.click(button);

    expect(input).toHaveValue('');
  });

  it('submitting with an empty or whitespace-only input does NOT call onAdd', async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(<AddTodo onAdd={onAdd} />);

    const input = screen.getByPlaceholderText('Add a new todo...');
    const button = screen.getByRole('button', { name: 'Add' });

    // Submit with empty input
    await user.click(button);
    expect(onAdd).not.toHaveBeenCalled();

    // Submit with whitespace-only input
    await user.type(input, '   ');
    await user.click(button);
    expect(onAdd).not.toHaveBeenCalled();
  });
});
