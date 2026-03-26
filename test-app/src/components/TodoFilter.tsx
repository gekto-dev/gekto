import { FilterType } from '../types';

interface TodoFilterProps {
  currentFilter: FilterType;
  onFilterChange: (filter: FilterType) => void;
}

export default function TodoFilter({ currentFilter, onFilterChange }: TodoFilterProps) {
  return (
    <div className="filters">
      <button
        className={currentFilter === 'all' ? 'active' : undefined}
        onClick={() => onFilterChange('all')}
      >
        All
      </button>
      <button
        className={currentFilter === 'active' ? 'active' : undefined}
        onClick={() => onFilterChange('active')}
      >
        Active
      </button>
      <button
        className={currentFilter === 'completed' ? 'active' : undefined}
        onClick={() => onFilterChange('completed')}
      >
        Completed
      </button>
    </div>
  );
}
