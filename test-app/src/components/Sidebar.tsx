// Types defined locally - do not import from other task files
type FilterType = 'all' | 'active' | 'completed' | 'today' | 'upcoming'
type SortType = 'newest' | 'oldest' | 'dueDate'
type TaskList = { id: string; name: string; color: string; count: number }

interface SidebarProps {
  filter: FilterType
  setFilter: (f: FilterType) => void
  sort: SortType
  setSort: (s: SortType) => void
  lists: TaskList[]
  activeListId: string | null
  setActiveListId: (id: string | null) => void
  counts: {
    total: number
    active: number
    completed: number
    today: number
    upcoming: number
  }
}

export function Sidebar({
  filter,
  setFilter,
  sort,
  setSort,
  lists,
  activeListId,
  setActiveListId,
  counts,
}: SidebarProps) {
  const quickFilters: { type: FilterType; label: string; count: number; icon: string }[] = [
    { type: 'today', label: 'Today', count: counts.today, icon: '📅' },
    { type: 'upcoming', label: 'Upcoming', count: counts.upcoming, icon: '➡️' },
    { type: 'all', label: 'All Tasks', count: counts.total, icon: '📋' },
    { type: 'active', label: 'Active', count: counts.active, icon: '⏳' },
    { type: 'completed', label: 'Completed', count: counts.completed, icon: '✅' },
  ]

  const handleFilterClick = (type: FilterType) => {
    if (filter === type && activeListId === null) {
      // Already selected, don't trigger update
      return
    }
    setActiveListId(null)
    setFilter(type)
  }

  const handleListClick = (listId: string) => {
    if (activeListId === listId) {
      // Already selected, don't trigger update
      return
    }
    setFilter('all')
    setActiveListId(listId)
  }

  return (
    <div className="sidebar">
      {/* Quick Filters Section */}
      <div className="sidebar-section">
        <h3 className="sidebar-heading">Quick Filters</h3>
        <div className="sidebar-filters">
          {quickFilters.map(({ type, label, count, icon }) => (
            <button
              key={type}
              className={`sidebar-btn ${filter === type && activeListId === null ? 'sidebar-btn-active' : ''}`}
              onClick={() => handleFilterClick(type)}
            >
              <span className="sidebar-btn-icon">{icon}</span>
              <span className="sidebar-btn-label">{label}</span>
              <span className="sidebar-btn-count">{count}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Lists Section */}
      <div className="sidebar-section">
        <h3 className="sidebar-heading">Lists</h3>
        <div className="sidebar-filters">
          {lists.length === 0 ? (
            <div className="sidebar-empty">No lists</div>
          ) : (
            lists.map((list) => (
              <button
                key={list.id}
                className={`sidebar-btn ${activeListId === list.id ? 'sidebar-btn-active' : ''}`}
                onClick={() => handleListClick(list.id)}
              >
                <span
                  className="sidebar-list-dot"
                  style={{ backgroundColor: list.color }}
                />
                <span className="sidebar-btn-label">{list.name}</span>
                <span className="sidebar-btn-count">{list.count}</span>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Sort Section */}
      <div className="sidebar-section">
        <h3 className="sidebar-heading">Sort</h3>
        <select
          className="sidebar-select"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortType)}
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="dueDate">Due date</option>
        </select>
      </div>
    </div>
  )
}

export type { FilterType, SortType, TaskList }
