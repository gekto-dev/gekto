import { useState, type FormEvent } from 'react'

interface TodoInputProps {
  onAdd: (text: string) => void
}

export function TodoInput({ onAdd }: TodoInputProps) {
  const [text, setText] = useState('')

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (text.trim()) {
      onAdd(text)
      setText('')
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', gap: 12 }}>
        <input
          type="text"
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="What needs to be done?"
          style={{
            flex: 1,
            padding: '12px 16px',
            fontSize: 16,
            background: '#1a1a1a',
            border: '1px solid #333',
            borderRadius: 8,
            color: '#e0e0e0',
            outline: 'none',
          }}
        />
        <button
          type="submit"
          style={{
            padding: '12px 24px',
            fontSize: 16,
            fontWeight: 500,
            background: '#4ade80',
            border: 'none',
            borderRadius: 8,
            color: '#111',
            cursor: 'pointer',
          }}
        >
          Add
        </button>
      </div>
    </form>
  )
}
