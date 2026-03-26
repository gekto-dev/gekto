import React, { useState } from 'react';
import { List } from '../types';

interface ListSelectorProps {
  lists: List[];
  activeListId: string;
  onSelectList: (id: string) => void;
  onAddList: (name: string) => void;
}

export function ListSelector({
  lists,
  activeListId,
  onSelectList,
  onAddList,
}: ListSelectorProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [newListName, setNewListName] = useState('');

  const handleSave = () => {
    const trimmedName = newListName.trim();
    if (trimmedName) {
      onAddList(trimmedName);
      setNewListName('');
      setIsAdding(false);
    }
  };

  const handleCancel = () => {
    setNewListName('');
    setIsAdding(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSave();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleCancel();
    }
  };

  return (
    <aside className="list-sidebar">
      <h2>Lists</h2>
      <ul>
        {lists.map((list) => (
          <li key={list.id}>
            <button
              className={list.id === activeListId ? 'list-item active' : 'list-item'}
              onClick={() => onSelectList(list.id)}
            >
              {list.name}
            </button>
          </li>
        ))}
      </ul>

      {isAdding ? (
        <div className="add-list-form">
          <input
            type="text"
            value={newListName}
            onChange={(e) => setNewListName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="List name"
            autoFocus
          />
          <button
            onClick={handleSave}
            disabled={!newListName.trim()}
          >
            Save
          </button>
          <button onClick={handleCancel}>
            Cancel
          </button>
        </div>
      ) : (
        <button
          className="add-list-btn"
          onClick={() => setIsAdding(true)}
        >
          Add List
        </button>
      )}
    </aside>
  );
}
