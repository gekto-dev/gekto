import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { FilterType } from '../types';
import TodoFilter from './TodoFilter';

describe('TodoFilter', () => {
  it('renders all three filter buttons', () => {
    const onFilterChange = vi.fn();
    render(<TodoFilter currentFilter="all" onFilterChange={onFilterChange} />);

    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Active' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Completed' })).toBeInTheDocument();
  });

  it('highlights the active filter button with active class', () => {
    const onFilterChange = vi.fn();
    render(<TodoFilter currentFilter="active" onFilterChange={onFilterChange} />);

    const allButton = screen.getByRole('button', { name: 'All' });
    const activeButton = screen.getByRole('button', { name: 'Active' });
    const completedButton = screen.getByRole('button', { name: 'Completed' });

    expect(allButton).not.toHaveClass('active');
    expect(activeButton).toHaveClass('active');
    expect(completedButton).not.toHaveClass('active');
  });

  it('calls onFilterChange with "all" when All button is clicked', async () => {
    const user = userEvent.setup();
    const onFilterChange = vi.fn();
    render(<TodoFilter currentFilter="completed" onFilterChange={onFilterChange} />);

    await user.click(screen.getByRole('button', { name: 'All' }));

    expect(onFilterChange).toHaveBeenCalledTimes(1);
    expect(onFilterChange).toHaveBeenCalledWith('all');
  });

  it('calls onFilterChange with "active" when Active button is clicked', async () => {
    const user = userEvent.setup();
    const onFilterChange = vi.fn();
    render(<TodoFilter currentFilter="all" onFilterChange={onFilterChange} />);

    await user.click(screen.getByRole('button', { name: 'Active' }));

    expect(onFilterChange).toHaveBeenCalledTimes(1);
    expect(onFilterChange).toHaveBeenCalledWith('active');
  });

  it('calls onFilterChange with "completed" when Completed button is clicked', async () => {
    const user = userEvent.setup();
    const onFilterChange = vi.fn();
    render(<TodoFilter currentFilter="all" onFilterChange={onFilterChange} />);

    await user.click(screen.getByRole('button', { name: 'Completed' }));

    expect(onFilterChange).toHaveBeenCalledTimes(1);
    expect(onFilterChange).toHaveBeenCalledWith('completed');
  });

  it('changes highlighted button when currentFilter prop changes', () => {
    const onFilterChange = vi.fn();
    const { rerender } = render(
      <TodoFilter currentFilter="all" onFilterChange={onFilterChange} />
    );

    const allButton = screen.getByRole('button', { name: 'All' });
    const activeButton = screen.getByRole('button', { name: 'Active' });
    const completedButton = screen.getByRole('button', { name: 'Completed' });

    // Initially "all" is active
    expect(allButton).toHaveClass('active');
    expect(activeButton).not.toHaveClass('active');
    expect(completedButton).not.toHaveClass('active');

    // Change to "completed"
    rerender(<TodoFilter currentFilter="completed" onFilterChange={onFilterChange} />);

    expect(allButton).not.toHaveClass('active');
    expect(activeButton).not.toHaveClass('active');
    expect(completedButton).toHaveClass('active');

    // Change to "active"
    rerender(<TodoFilter currentFilter="active" onFilterChange={onFilterChange} />);

    expect(allButton).not.toHaveClass('active');
    expect(activeButton).toHaveClass('active');
    expect(completedButton).not.toHaveClass('active');
  });
});
