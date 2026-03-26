import { createContext, useContext, useState, useCallback, useEffect, useRef, useMemo, type ReactNode } from 'react'
import { useStore, type Agent } from '../store/store'
import { useServerState } from '../hooks/useServerState'

type ChatMode = 'task' | 'plan'
type Arrangement = 'grid' | 'stack' | 'row' | 'column'
type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

interface Position {
  x: number
  y: number
}

// Local visual state per agent (not persisted to global store)
interface LizardVisual {
  position: Position
  color: string
}

interface LizardInstance {
  id: string
  getPosition: () => Position
  setPosition: (pos: Position) => void
  size: number
}

interface SwarmContextValue {
  // Visual state for agents (local only)
  visuals: Record<string, LizardVisual>

  // Selection state
  selectedIds: Set<string>

  // Chat state
  activeChatId: string | null
  chatMode: ChatMode

  // Whiteboard
  isWhiteboardOpen: boolean
  setWhiteboardOpen: (open: boolean) => void

  // Actions
  addAgent: (position?: Position) => void
  deleteAgent: (id: string) => void
  updateColor: (id: string, color: string) => void
  getVisual: (id: string) => LizardVisual | undefined
  openChat: (id: string, mode: ChatMode) => void
  closeChat: () => void
  toggleSelection: (id: string, addToSelection: boolean) => void
  clearSelection: () => void

  // Lizard instance registration (for position tracking and arrangement)
  registerLizard: (id: string, getPosition: () => Position, setPosition: (pos: Position) => void, size: number) => void
  unregisterLizard: (id: string) => void

  // Arrangement
  arrange: () => void

  // Persistence
  saveVisuals: () => void
}

const SwarmContext = createContext<SwarmContextValue | null>(null)
const SelectionRectContext = createContext<{ startX: number; startY: number; endX: number; endY: number } | null>(null)

export function useSwarm() {
  const context = useContext(SwarmContext)
  if (!context) {
    throw new Error('useSwarm must be used within a SwarmProvider')
  }
  return context
}

export function useSelectionRect() {
  return useContext(SelectionRectContext)
}

interface SwarmProviderProps {
  children: ReactNode
  initialVisuals?: Record<string, LizardVisual>
  arrangement?: Arrangement
  corner?: Corner
  gap?: number
  arrangeHotkey?: string
}

function parseHue(color: string): number | null {
  const hslMatch = color.match(/hsl\((\d+)/)
  if (hslMatch) return parseInt(hslMatch[1])
  if (color.startsWith('#')) {
    const hex = color.slice(1)
    const r = parseInt(hex.substring(0, 2), 16) / 255
    const g = parseInt(hex.substring(2, 4), 16) / 255
    const b = parseInt(hex.substring(4, 6), 16) / 255
    const max = Math.max(r, g, b), min = Math.min(r, g, b)
    if (max === min) return 0
    const d = max - min
    let h = 0
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
    else if (max === g) h = ((b - r) / d + 2) / 6
    else h = ((r - g) / d + 4) / 6
    return Math.round(h * 360)
  }
  return null
}

function randomDistinctColor(existingColors: string[]): string {
  const existingHues = existingColors.map(parseHue).filter((h): h is number => h !== null)
  const MIN_HUE_DISTANCE = 45

  let bestHue = Math.floor(Math.random() * 360)
  let bestMinDistance = 0

  for (let attempt = 0; attempt < 72; attempt++) {
    const candidateHue = (attempt * 5 + Math.floor(Math.random() * 5)) % 360
    let minDistance = 180

    for (const existingHue of existingHues) {
      const distance = Math.min(
        Math.abs(candidateHue - existingHue),
        360 - Math.abs(candidateHue - existingHue)
      )
      minDistance = Math.min(minDistance, distance)
    }

    if (minDistance > bestMinDistance) {
      bestMinDistance = minDistance
      bestHue = candidateHue
      if (minDistance >= MIN_HUE_DISTANCE) break
    }
  }

  const saturation = 70 + Math.floor(Math.random() * 20)
  const lightness = 60 + Math.floor(Math.random() * 15)
  return `hsl(${bestHue}, ${saturation}%, ${lightness}%)`
}

const LIZARD_SIZE = 90

export function SwarmProvider({
  children,
  initialVisuals = {},
  arrangement = 'grid',
  corner = 'bottom-right',
  gap = -30,
  arrangeHotkey = 'ArrowRight',
}: SwarmProviderProps) {
  // Global store
  const agents = useStore((s) => s.agents)
  const storeCreateAgent = useStore((s) => s.createAgent)
  const storeDeleteAgent = useStore((s) => s.deleteAgent)

  // Server state for persisted visuals
  const { state: serverState, send } = useServerState()

  // Local visual state — initialized from server state visuals
  const [visuals, setVisuals] = useState<Record<string, LizardVisual>>(initialVisuals)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [chatMode, setChatMode] = useState<ChatMode>('task')
  const lizardInstancesRef = useRef<Map<string, LizardInstance>>(new Map())
  const [isWhiteboardOpen, setWhiteboardOpen] = useState(() => {
    try {
      const stored = localStorage.getItem('gekto-whiteboard-open')
      return stored !== null ? stored === 'true' : true
    } catch { return true }
  })
  const [selectionRect, setSelectionRect] = useState<{ startX: number; startY: number; endX: number; endY: number } | null>(null)
  const [isShiftPressed, setIsShiftPressed] = useState(false)
  const initializedFromServerRef = useRef(false)

  // Persist whiteboard open/closed state
  useEffect(() => {
    try { localStorage.setItem('gekto-whiteboard-open', String(isWhiteboardOpen)) } catch {}
  }, [isWhiteboardOpen])

  // Ref for visuals
  const visualsRef = useRef(visuals)
  useEffect(() => {
    visualsRef.current = visuals
  }, [visuals])

  // Load visuals from server state on first snapshot
  useEffect(() => {
    if (!initializedFromServerRef.current && serverState.visuals && Object.keys(serverState.visuals).length > 0) {
      setVisuals(serverState.visuals)
      initializedFromServerRef.current = true
    }
  }, [serverState.visuals])

  // Auto-create visuals for new agents
  const agentIds = Object.keys(agents)
  const newAgentIds = agentIds.filter(id => !visuals[id])

  if (newAgentIds.length > 0) {
    const next = { ...visuals }
    const existingColors = Object.values(visuals).map(v => v.color)

    newAgentIds.forEach((id) => {
      const color = randomDistinctColor([...existingColors])
      existingColors.push(color)

      const agentIndex = agentIds.indexOf(id)
      const padding = 30
      const originX = window.innerWidth - LIZARD_SIZE - padding
      const originY = window.innerHeight - LIZARD_SIZE - padding
      const rows = Math.floor((window.innerHeight * 0.7) / (LIZARD_SIZE + gap)) || 1
      const row = agentIndex % rows
      const col = Math.floor(agentIndex / rows)

      next[id] = {
        position: {
          x: originX - col * (LIZARD_SIZE + gap),
          y: originY - row * (LIZARD_SIZE + gap),
        },
        color,
      }
    })

    setVisuals(next)
  }

  // Track shift key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setIsShiftPressed(true)
    }
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setIsShiftPressed(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [])

  // Refs for selection
  const startPosRef = useRef<Position | null>(null)
  const selectionRectRef = useRef<typeof selectionRect>(null)
  const selectedIdsRef = useRef(selectedIds)

  useEffect(() => {
    selectionRectRef.current = selectionRect
  }, [selectionRect])

  useEffect(() => {
    selectedIdsRef.current = selectedIds
  }, [selectedIds])

  // Rectangular selection with shift+drag
  useEffect(() => {
    if (!isShiftPressed) {
      setSelectionRect(null)
      return
    }

    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('[data-selectable]')) return
      startPosRef.current = { x: e.clientX, y: e.clientY }
      setSelectionRect({ startX: e.clientX, startY: e.clientY, endX: e.clientX, endY: e.clientY })
    }

    const handleMouseMove = (e: MouseEvent) => {
      if (!startPosRef.current) return
      setSelectionRect({
        startX: startPosRef.current.x,
        startY: startPosRef.current.y,
        endX: e.clientX,
        endY: e.clientY,
      })
    }

    const handleMouseUp = () => {
      const currentRect = selectionRectRef.current
      if (currentRect) {
        const rect = getNormalizedRect(currentRect)
        const newSelected = new Set(selectedIdsRef.current)

        lizardInstancesRef.current.forEach(instance => {
          const pos = instance.getPosition()
          const itemCenter = { x: pos.x + instance.size / 2, y: pos.y + instance.size / 2 }
          if (isPointInRect(itemCenter, rect)) {
            newSelected.add(instance.id)
          }
        })

        setSelectedIds(newSelected)
      }
      startPosRef.current = null
      setSelectionRect(null)
    }

    window.addEventListener('mousedown', handleMouseDown)
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousedown', handleMouseDown)
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isShiftPressed])

  // Backspace to delete selected
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Backspace' && selectedIds.size > 0) {
        selectedIds.forEach(id => {
          storeDeleteAgent(id)
          setVisuals(prev => {
            const next = { ...prev }
            delete next[id]
            return next
          })
        })
        if (activeChatId && selectedIds.has(activeChatId)) {
          setActiveChatId(null)
        }
        setSelectedIds(new Set())
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedIds, activeChatId, storeDeleteAgent])

  // Click outside to clear selection
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (e.shiftKey) return
      const target = e.target as HTMLElement
      if (!target.closest('[data-selectable]') && !target.closest('[data-swarm-ui]')) {
        setSelectedIds(new Set())
      }
    }

    window.addEventListener('click', handleClick)
    return () => window.removeEventListener('click', handleClick)
  }, [])

  // Add new agent
  const addAgent = useCallback((position?: Position) => {
    const id = `agent_${Date.now()}`
    const agent: Agent = {
      id,
      taskId: '',
      personaId: 'plain',
      status: 'idle',
    }
    storeCreateAgent(agent)

    if (position) {
      const existingColors = Object.values(visualsRef.current).map(v => v.color)
      const color = randomDistinctColor(existingColors)
      setVisuals(prev => ({
        ...prev,
        [id]: { position, color },
      }))
    }
  }, [storeCreateAgent])

  const deleteAgent = useCallback((id: string) => {
    storeDeleteAgent(id)
    setVisuals(prev => {
      const next = { ...prev }
      delete next[id]
      return next
    })
    if (activeChatId === id) {
      setActiveChatId(null)
    }
  }, [storeDeleteAgent, activeChatId])

  const updateColor = useCallback((id: string, color: string) => {
    setVisuals(prev => ({
      ...prev,
      [id]: { ...prev[id], color },
    }))
  }, [])

  const getVisual = useCallback((id: string): LizardVisual | undefined => {
    return visuals[id]
  }, [visuals])

  const openChat = useCallback((id: string, mode: ChatMode) => {
    setActiveChatId(id)
    setChatMode(mode)
  }, [])

  const closeChat = useCallback(() => {
    setActiveChatId(null)
  }, [])

  const toggleSelection = useCallback((id: string, addToSelection: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(addToSelection ? prev : [])
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
  }, [])

  const registerLizard = useCallback((id: string, getPosition: () => Position, setPosition: (pos: Position) => void, size: number) => {
    lizardInstancesRef.current.set(id, { id, getPosition, setPosition, size })
  }, [])

  const unregisterLizard = useCallback((id: string) => {
    lizardInstancesRef.current.delete(id)
  }, [])

  // Save visuals to server state via WS
  const saveVisuals = useCallback(() => {
    const data: Record<string, LizardVisual> = {}
    for (const [id, visual] of Object.entries(visualsRef.current)) {
      const instance = lizardInstancesRef.current.get(id)
      const position = instance ? instance.getPosition() : visual.position
      data[id] = { position, color: visual.color }
    }

    send({ type: 'save_visuals', visuals: data })
  }, [send])

  const arrange = useCallback(() => {
    const instances = Array.from(lizardInstancesRef.current.values())
    if (instances.length === 0) return

    const avgSize = instances.reduce((sum, inst) => sum + inst.size, 0) / instances.length
    const padding = 30

    let originX: number, originY: number, dirX: number, dirY: number

    switch (corner) {
      case 'top-left':
        originX = padding; originY = padding; dirX = 1; dirY = 1
        break
      case 'top-right':
        originX = window.innerWidth - avgSize - padding; originY = padding; dirX = -1; dirY = 1
        break
      case 'bottom-left':
        originX = padding; originY = window.innerHeight - avgSize - padding; dirX = 1; dirY = -1
        break
      case 'bottom-right':
      default:
        originX = window.innerWidth - avgSize - padding
        originY = window.innerHeight - avgSize - padding
        dirX = -1; dirY = -1
        break
    }

    instances.forEach((instance, index) => {
      let x: number, y: number

      switch (arrangement) {
        case 'stack':
          x = originX; y = originY
          break
        case 'row':
          x = originX + dirX * index * (instance.size + gap); y = originY
          break
        case 'column':
          x = originX; y = originY + dirY * index * (instance.size + gap)
          break
        case 'grid':
        default: {
          const rows = Math.floor((window.innerHeight * 0.8) / (avgSize + gap)) || 1
          const row = index % rows
          const col = Math.floor(index / rows)
          x = originX + dirX * col * (instance.size + gap)
          y = originY + dirY * row * (instance.size + gap)
          break
        }
      }

      instance.setPosition({ x, y })
    })

    setTimeout(saveVisuals, 50)
  }, [arrangement, corner, gap, saveVisuals])

  // Arrange hotkey
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === arrangeHotkey) {
        arrange()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [arrangeHotkey, arrange])

  const value = useMemo<SwarmContextValue>(() => ({
    visuals,
    selectedIds,
    activeChatId,
    chatMode,
    isWhiteboardOpen,
    setWhiteboardOpen,
    addAgent,
    deleteAgent,
    updateColor,
    getVisual,
    openChat,
    closeChat,
    toggleSelection,
    clearSelection,
    registerLizard,
    unregisterLizard,
    arrange,
    saveVisuals,
  }), [visuals, selectedIds, activeChatId, chatMode, isWhiteboardOpen, addAgent, deleteAgent, updateColor, getVisual, openChat, closeChat, toggleSelection, clearSelection, registerLizard, unregisterLizard, arrange, saveVisuals])

  return (
    <SwarmContext.Provider value={value}>
      <SelectionRectContext.Provider value={selectionRect}>
        {children}
      </SelectionRectContext.Provider>
    </SwarmContext.Provider>
  )
}

// Helpers
function getNormalizedRect(rect: { startX: number; startY: number; endX: number; endY: number }) {
  return {
    left: Math.min(rect.startX, rect.endX),
    top: Math.min(rect.startY, rect.endY),
    right: Math.max(rect.startX, rect.endX),
    bottom: Math.max(rect.startY, rect.endY),
  }
}

function isPointInRect(point: Position, rect: { left: number; top: number; right: number; bottom: number }) {
  return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
}

export type { LizardVisual, ChatMode, Position }
