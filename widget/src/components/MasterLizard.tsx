import { useEffect, useRef, useState } from 'react'
import { ChatBubbleIcon, PlusCircledIcon, Cross2Icon, DashboardIcon } from '@radix-ui/react-icons'
import { LizardAvatar } from './LizardAvatar'
import { ChatWindow, getChatSize } from './ChatWindow'
import { GektoPlanPanel } from './GektoPlanPanel'
import { RadialMenu } from './RadialMenu'
import { useDraggable } from '../hooks/useDraggable'
import { useSwarm } from '../context/SwarmContext'
import { useAgent } from '../context/AgentContext'
import { useGekto } from '../context/GektoContext'
import { useStore } from '../store/store'

const MASTER_LIZARD_SIZE = 140
const MASTER_ID = 'master'
const MASTER_COLOR = '#BFFF6B'

export function MasterLizard() {
  const {
    activeChatId,
    chatMode,
    openChat,
    closeChat,
    saveVisuals,
    addAgent,
    isWhiteboardOpen,
    setWhiteboardOpen,
  } = useSwarm()

  const storeClearAllAgents = useStore((s) => s.clearAllAgents)

  const { sessions } = useAgent()
  // Subscribe to sessions to trigger re-render on state changes
  sessions.get(MASTER_ID)

  const { currentPlan, isPlanPanelOpen, openPlanPanel, closePlanPanel } = useGekto()

  const isChatOpen = activeChatId === MASTER_ID
  const inputRef = useRef<HTMLInputElement>(null)
  const [isHovered, setIsHovered] = useState(false)
  const [chatSize, setChatSize] = useState(getChatSize)

  // Close plan panel when chat closes (opening is handled by plan_created event in GektoContext)
  useEffect(() => {
    if (!isChatOpen) {
      closePlanPanel()
    }
  }, [isChatOpen, closePlanPanel])

  const menuItems = [
    {
      id: 'chat',
      icon: <ChatBubbleIcon width={20} height={20} />,
      label: isChatOpen ? 'Close Chat' : 'Chat',
      hotkey: undefined,
      active: isChatOpen,
      onClick: () => isChatOpen ? closeChat() : openChat(MASTER_ID, 'task'),
    },
    {
      id: 'spawn',
      icon: <PlusCircledIcon width={20} height={20} />,
      label: 'Spawn Agent',
      hotkey: '⇧|',
      onClick: () => {
        addAgent()
      },
    },
    {
      id: 'whiteboard',
      icon: <DashboardIcon width={20} height={20} />,
      label: isWhiteboardOpen ? 'Close Board' : 'Whiteboard',
      hotkey: '⇧␣',
      active: isWhiteboardOpen,
      onClick: () => {
        setWhiteboardOpen(!isWhiteboardOpen)
      },
    },
    {
      id: 'clear',
      icon: <Cross2Icon width={16} height={16} />,
      label: 'Clear All',
      onClick: () => {
        storeClearAllAgents()
      },
      danger: true,
      holdDuration: 500,
    },
  ]

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't capture if user is typing in an input or textarea
      const target = e.target as HTMLElement
      if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
        return
      }

      // Shift+\ to spawn agent
      if (e.shiftKey && e.key === '|') {
        e.preventDefault()
        addAgent()
        return
      }

      // Shift+Space to toggle whiteboard
      if (e.shiftKey && e.key === ' ') {
        e.preventDefault()
        setWhiteboardOpen(!isWhiteboardOpen)
        return
      }

      // Shift+ESC to close whiteboard
      if (e.shiftKey && e.key === 'Escape') {
        if (isWhiteboardOpen) {
          e.preventDefault()
          setWhiteboardOpen(false)
        }
        return
      }

      // ESC to close chat only
      if (e.key === 'Escape') {
        if (activeChatId) {
          e.preventDefault()
          closeChat()
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [openChat, activeChatId, closeChat, isWhiteboardOpen, setWhiteboardOpen, addAgent])

  const { ref, position, isDragging, hasMoved, handlers } = useDraggable({
    initialPosition: {
      x: 30,
      y: window.innerHeight - MASTER_LIZARD_SIZE - 30,
    },
    onDragEnd: (_, moved) => {
      if (moved) {
        saveVisuals()
      }
    },
  })

  const handleClick = (e: React.MouseEvent) => {
    // Don't open chat if clicking on menu items
    if ((e.target as HTMLElement).closest('[data-radial-menu]')) {
      return
    }
    if (!hasMoved()) {
      isChatOpen ? closeChat() : openChat(MASTER_ID, 'task')
    }
  }

  return (
    <>
      {/* Master Lizard */}
      <div
        ref={ref}
        className={`fixed cursor-pointer hover:scale-105 ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
        style={{
          left: position.x,
          top: position.y,
          zIndex: 1003,
          pointerEvents: 'auto',
          transition: isDragging ? 'transform 0.2s ease-out' : 'left 0.4s ease-out, top 0.4s ease-out, transform 0.2s ease-out',
        }}
        onMouseDown={handlers.onMouseDown}
        onClick={handleClick}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <LizardAvatar size={MASTER_LIZARD_SIZE} color={MASTER_COLOR} faceRight />

        {/* Extended hover area for menu (above lizard) */}
        <div
          className="absolute pointer-events-auto"
          style={{
            left: 0,
            bottom: MASTER_LIZARD_SIZE - 20,
            width: MASTER_LIZARD_SIZE,
            height: 300,
          }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        />


      </div>

      {/* Radial Menu - rendered outside lizard div, above chat panel */}
      <div
        className="fixed"
        style={{
          left: position.x,
          top: position.y,
          zIndex: 1004,
          pointerEvents: 'none',
        }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <RadialMenu
          items={menuItems}
          isVisible={isHovered && !isDragging}
          size={MASTER_LIZARD_SIZE}
          side="right"
        />
      </div>

      {/* Chat Window - positioned to the right of master lizard */}
      {/* Always mounted (CSS hide) to preserve chat state across open/close cycles */}
      <div
        className="fixed"
        data-swarm-ui
        style={{
          left: position.x + MASTER_LIZARD_SIZE + 20,
          top: position.y + MASTER_LIZARD_SIZE - chatSize.height,
          zIndex: 1002,
          pointerEvents: isChatOpen ? 'auto' : 'none',
          display: isChatOpen ? undefined : 'none',
        }}
      >
        <ChatWindow
          lizardId={MASTER_ID}
          title={chatMode === 'plan' ? 'Master Plan' : 'Gekto Chat'}
          color="rgba(191, 255, 107, 0.5)"
          onClose={closeChat}
          onResize={setChatSize}
          inputRef={inputRef}
          onHeaderMouseDown={handlers.onMouseDown}
        />
      </div>

      {/* Plan Panel - positioned to the right of chat or master lizard */}
      {isPlanPanelOpen && currentPlan && (
        <GektoPlanPanel
          position={{
            x: isChatOpen
              ? position.x + MASTER_LIZARD_SIZE + 20 + chatSize.width + 4  // Right of chat
              : position.x + MASTER_LIZARD_SIZE + 20,       // Right of master
            y: position.y + MASTER_LIZARD_SIZE - chatSize.height,
          }}
          height={chatSize.height}
          onClose={closePlanPanel}
        />
      )}
    </>
  )
}

export { MASTER_ID, MASTER_LIZARD_SIZE }
