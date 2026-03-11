import { useEffect, useRef } from 'react'
import { Editor, createShapeId } from 'tldraw'
import type { TLShapeId } from 'tldraw'
import type { Agent, Task } from '../../store/store'
import type { TaskShape, TaskStatus as ShapeStatus } from './TaskShape'
import { orderFrameElements } from './orderFrameElements'

// Card dimensions for task shapes
const CARD_WIDTH = 300
const CARD_HEIGHT = 200

// Gap between shapes when resolving overlaps
const PLACEMENT_GAP = 24

// How long to keep deleted agent data for undo (30 seconds)
const UNDO_BUFFER_TTL = 30_000

// Map Claude tool names to shape status
const TOOL_TO_STATUS: Record<string, ShapeStatus> = {
  Read: 'READ',
  Write: 'WRITE',
  Edit: 'EDIT',
  Bash: 'BASH',
  Grep: 'GREP',
  Glob: 'GREP',  // Glob is similar to Grep for display
  Task: 'WRITE', // Task agent shows as writing
  WebFetch: 'READ',
  WebSearch: 'READ',
}

// ============ Normalizer ============

/**
 * Convert Agent + Task → props object (same format as "Add Tasks" button)
 */
function buildShapeProps(agent: Agent, task: Task | undefined, index: number, currentTool?: string, streamingText?: string, workingDir?: string, fileChangeCount?: number): Record<string, unknown> {
  // Map agent status to shape status
  let status: ShapeStatus = 'idle'
  if (agent.status === 'error') status = 'error'
  else if (agent.status === 'done') status = 'done'
  else if (agent.status === 'pending') status = 'pending'
  else if (agent.status === 'working') {
    // Use current tool if available, otherwise default to READ (agent is thinking)
    status = (currentTool && TOOL_TO_STATUS[currentTool]) || 'READ'
  }
  else if (agent.status === 'idle') status = 'idle'

  // Generate friendly name if no task
  const title = task?.name || `Agent ${index + 1}`

  // Abstract always shows task description — agent response goes to chat, not here
  const abstract = task?.description || ''

  // Build props - only include optional fields if they have values (like Add Tasks button)
  const props: Record<string, unknown> = {
    w: CARD_WIDTH,
    h: CARD_HEIGHT,
    title,
    abstract,
    status,
  }

  // Only show errors on card, not results (results are in chat)
  if (task?.error) props.message = task.error
  else props.message = ''

  // Always include agentId for reverse lookup
  props.agentId = agent.id

  // Working directory for footer
  if (workingDir) props.workingDir = workingDir

  // File change count for diff button (always set so tldraw merges it to 0 when cleared)
  props.fileChangeCount = fileChangeCount ?? 0

  return props
}

// ============ Collision Avoidance ============

/**
 * Find a non-overlapping position for a new shape, starting from the desired
 * position and shifting right until it no longer intersects any existing shape.
 * Only considers top-level shapes (not children of frames).
 */
function findNonOverlappingPosition(
  editor: Editor,
  desiredX: number,
  desiredY: number,
  width: number,
  height: number,
  excludeIds?: Set<TLShapeId>,
): { x: number; y: number } {
  // Collect bounding boxes of all existing top-level shapes on the current page
  const pageShapes = editor.getCurrentPageShapes().filter(s => {
    // Skip shapes inside frames (they're managed by orderFrameElements)
    if (s.parentId !== editor.getCurrentPageId()) return false
    // Skip shapes we're about to create
    if (excludeIds?.has(s.id)) return false
    return true
  })

  const existingBoxes = pageShapes
    .map(s => editor.getShapePageBounds(s))
    .filter((b): b is NonNullable<typeof b> => b !== null && b !== undefined)

  let x = desiredX
  const y = desiredY

  // Keep shifting right until no overlap (max 50 iterations to avoid infinite loop)
  for (let attempt = 0; attempt < 50; attempt++) {
    const cx = x
    const cy = y
    const cRight = cx + width
    const cBottom = cy + height

    let hasOverlap = false
    let maxRight = x

    for (const box of existingBoxes) {
      if (
        cx < box.maxX + PLACEMENT_GAP &&
        cRight > box.x - PLACEMENT_GAP &&
        cy < box.maxY + PLACEMENT_GAP &&
        cBottom > box.y - PLACEMENT_GAP
      ) {
        hasOverlap = true
        maxRight = Math.max(maxRight, box.maxX)
      }
    }

    if (!hasOverlap) {
      return { x, y }
    }

    // Jump to the right of the rightmost overlapping shape
    x = maxRight + PLACEMENT_GAP
  }

  return { x, y }
}

// ============ Hook ============

interface AgentWithTask {
  agent: Agent
  task?: Task
  currentTool?: string
  streamingText?: string
  workingDir?: string
  fileChangeCount?: number
}

interface DeletedAgentData {
  agent: Agent
  task?: Task
  deletedAt: number
}

/**
 * Syncs agents to TaskShapes on tldraw canvas.
 * Creates shapes exactly like the "Add Tasks" button does.
 * Also syncs deletions back: when user deletes a shape, the agent is removed from store.
 * Supports undo: when tldraw restores a shape via Cmd+Z, the agent is re-created.
 */
export function useAgentShapeSync(
  editor: Editor | null,
  agentsWithTasks: AgentWithTask[],
  onDeleteAgent?: (agentId: string) => void,
  onRestoreAgent?: (agent: Agent, task?: Task) => void
) {
  // Map agent ID -> shape ID (since we use random IDs like Add Tasks button)
  const agentToShapeRef = useRef<Map<string, TLShapeId>>(new Map())
  // Track shapes we're deleting ourselves (to avoid triggering onDeleteAgent)
  const deletingShapesRef = useRef<Set<TLShapeId>>(new Set())
  // Buffer of recently deleted agents for undo support
  const deletedAgentsRef = useRef<Map<string, DeletedAgentData>>(new Map())

  // Periodically clean expired entries from undo buffer
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now()
      for (const [id, data] of deletedAgentsRef.current) {
        if (now - data.deletedAt > UNDO_BUFFER_TTL) {
          deletedAgentsRef.current.delete(id)
        }
      }
    }, 10_000)
    return () => clearInterval(interval)
  }, [])

  // Main sync effect
  useEffect(() => {
    if (!editor) return

    const agentToShape = agentToShapeRef.current
    const currentAgentIds = new Set(agentsWithTasks.map(a => a.agent.id))

    // 1. Create shapes for NEW agents (or link to existing shapes from localStorage)
    // First pass: link existing shapes and collect truly new agents
    const newAgents: typeof agentsWithTasks = []
    for (let i = 0; i < agentsWithTasks.length; i++) {
      const { agent } = agentsWithTasks[i]
      if (!agentToShape.has(agent.id)) {
        // Check if a shape with this agentId already exists (from tldraw localStorage)
        const existingShape = editor.getCurrentPageShapes().find(
          s => (s.type as string) === 'task' &&
               (s as unknown as TaskShape).props?.agentId === agent.id
        )

        if (existingShape) {
          agentToShape.set(agent.id, existingShape.id)
        } else {
          newAgents.push(agentsWithTasks[i])
        }
      }
      // Clear from undo buffer if agent is back (restored successfully)
      deletedAgentsRef.current.delete(agent.id)
    }

    // Second pass: place new agents at viewport center (or into selected frame)
    if (newAgents.length > 0) {
      const viewportCenter = editor.getViewportScreenCenter()
      const pageCenter = editor.screenToPage(viewportCenter)

      // Check if a frame is currently selected — if so, put agents inside it
      const selectedShapes = editor.getSelectedShapes()
      const selectedFrame = selectedShapes.length === 1 && selectedShapes[0].type === 'frame'
        ? selectedShapes[0]
        : null

      if (selectedFrame) {
        // Place all new agents into the selected frame
        for (let i = 0; i < newAgents.length; i++) {
          const entry = newAgents[i]
          const idx = agentsWithTasks.indexOf(entry)
          const props = buildShapeProps(entry.agent, entry.task, idx, entry.currentTool, entry.streamingText, entry.workingDir, entry.fileChangeCount)
          const shapeId = createShapeId()

          try {
            editor.createShape({
              id: shapeId,
              type: 'task' as const,
              x: 0,
              y: 0,
              parentId: selectedFrame.id,
              props,
            } as any)
            agentToShape.set(entry.agent.id, shapeId)
          } catch (err) {
            console.error('[AgentShapeSync] Error creating shape:', err)
          }
        }

        // Re-arrange all children inside the frame
        orderFrameElements(editor, selectedFrame)
      } else if (newAgents.length === 1) {
        // Single agent, no frame selected: place at viewport center, avoiding overlaps
        const entry = newAgents[0]
        const idx = agentsWithTasks.indexOf(entry)
        const props = buildShapeProps(entry.agent, entry.task, idx, entry.currentTool, entry.streamingText, entry.workingDir, entry.fileChangeCount)
        const shapeId = createShapeId()

        const { x, y } = findNonOverlappingPosition(
          editor,
          pageCenter.x - CARD_WIDTH / 2,
          pageCenter.y - CARD_HEIGHT / 2,
          CARD_WIDTH,
          CARD_HEIGHT,
        )

        try {
          editor.createShape({
            id: shapeId,
            type: 'task' as const,
            x,
            y,
            props,
          } as any)
          agentToShape.set(entry.agent.id, shapeId)
        } catch (err) {
          console.error('[AgentShapeSync] Error creating shape:', err)
        }
      } else {
        // Batch, no frame selected: create a new frame at viewport center
        const count = newAgents.length
        const cols = Math.min(count, 3)
        const rows = Math.ceil(count / 3)
        const padding = 20
        const gap = 16
        const frameW = padding * 2 + cols * CARD_WIDTH + (cols - 1) * gap
        const frameH = padding * 2 + rows * CARD_HEIGHT + (rows - 1) * gap + 32 // 32 for title bar

        const frameId = createShapeId()
        const { x: frameX, y: frameY } = findNonOverlappingPosition(
          editor,
          pageCenter.x - frameW / 2,
          pageCenter.y - frameH / 2,
          frameW,
          frameH,
        )
        editor.createShape({
          id: frameId,
          type: 'frame',
          x: frameX,
          y: frameY,
          props: {
            w: frameW,
            h: frameH,
            name: 'Tasks',
          },
        })

        for (let i = 0; i < newAgents.length; i++) {
          const entry = newAgents[i]
          const idx = agentsWithTasks.indexOf(entry)
          const props = buildShapeProps(entry.agent, entry.task, idx, entry.currentTool, entry.streamingText, entry.workingDir, entry.fileChangeCount)
          const shapeId = createShapeId()

          try {
            editor.createShape({
              id: shapeId,
              type: 'task' as const,
              x: 0,
              y: 0,
              parentId: frameId,
              props,
            } as any)
            agentToShape.set(entry.agent.id, shapeId)
          } catch (err) {
            console.error('[AgentShapeSync] Error creating shape:', err)
          }
        }

        // Arrange children neatly inside the frame
        const frameShape = editor.getShape(frameId)
        orderFrameElements(editor, frameShape)
      }
    }

    // 2. Update props for EXISTING agents (no position change)
    for (let i = 0; i < agentsWithTasks.length; i++) {
      const { agent, task, currentTool, streamingText, workingDir, fileChangeCount } = agentsWithTasks[i]
      const shapeId = agentToShape.get(agent.id)
      if (shapeId) {
        const shape = editor.getShape(shapeId)
        if (shape) {
          const props = buildShapeProps(agent, task, i, currentTool, streamingText, workingDir, fileChangeCount)
          editor.updateShape({
            id: shapeId,
            type: 'task' as const,
            props,
          } as any)
        }
      }
    }

    // 3. Delete shapes for REMOVED agents (from our mapping)
    for (const [agentId, shapeId] of agentToShape.entries()) {
      if (!currentAgentIds.has(agentId)) {
        if (editor.getShape(shapeId)) {
          // Mark as our deletion so we don't trigger onDeleteAgent
          deletingShapesRef.current.add(shapeId)
          editor.deleteShape(shapeId)
          deletingShapesRef.current.delete(shapeId)
        }
        agentToShape.delete(agentId)
      }
    }

    // 4. Clean up orphaned shapes (have agentId but agent doesn't exist in store)
    // Skip if no agents loaded yet (snapshot hasn't arrived — don't wipe shapes)
    // Skip shapes whose agentId is in the undo buffer (might be restored via Cmd+Z)
    if (currentAgentIds.size > 0) {
      const allTaskShapes = editor.getCurrentPageShapes().filter(
        s => (s.type as string) === 'task'
      )
      for (const shape of allTaskShapes) {
        const taskShape = shape as unknown as TaskShape
        const agentId = taskShape.props?.agentId
        if (agentId && !currentAgentIds.has(agentId) && !deletedAgentsRef.current.has(agentId)) {
          deletingShapesRef.current.add(shape.id)
          editor.deleteShape(shape.id)
          deletingShapesRef.current.delete(shape.id)
        }
      }
    }
  }, [editor, agentsWithTasks])

  // Initialize: rebuild mapping from existing shapes with agentId
  useEffect(() => {
    if (!editor) return

    const agentToShape = agentToShapeRef.current
    const existingShapes = editor.getCurrentPageShapes().filter(
      s => (s.type as string) === 'task'
    )

    // Rebuild mapping from shapes that have agentId
    for (const shape of existingShapes) {
      const taskShape = shape as unknown as TaskShape
      if (taskShape.props?.agentId && !agentToShape.has(taskShape.props.agentId)) {
        agentToShape.set(taskShape.props.agentId, shape.id)
      }
    }
  }, [editor])

  // Listen for shape deletions AND additions from tldraw
  // Deletions: user deletes shape -> delete agent (+ buffer for undo)
  // Additions: tldraw undo restores shape -> restore agent from buffer
  useEffect(() => {
    if (!editor || !onDeleteAgent) return

    const agentToShape = agentToShapeRef.current

    const handleChange = (change: { changes: { removed?: Record<string, unknown>; added?: Record<string, unknown> } }) => {
      const removed = change.changes.removed
      const added = change.changes.added

      // Handle deletions: buffer agent data, then delete
      if (removed) {
        for (const shape of Object.values(removed) as Array<{ id: TLShapeId; type: string; props?: { agentId?: string } }>) {
          if (deletingShapesRef.current.has(shape.id)) continue
          if (shape.type === 'task' && shape.props?.agentId) {
            const agentId = shape.props.agentId

            // Snapshot agent+task data before deleting (for undo)
            const agentData = agentsWithTasks.find(a => a.agent.id === agentId)
            if (agentData) {
              deletedAgentsRef.current.set(agentId, {
                agent: { ...agentData.agent },
                task: agentData.task ? { ...agentData.task } : undefined,
                deletedAt: Date.now(),
              })
            }

            onDeleteAgent(agentId)
            agentToShape.delete(agentId)
          }
        }
      }

      // Handle additions: if shape has agentId in undo buffer, restore agent
      if (added && onRestoreAgent) {
        for (const shape of Object.values(added) as Array<{ id: TLShapeId; type: string; props?: { agentId?: string } }>) {
          if (shape.type === 'task' && shape.props?.agentId) {
            const agentId = shape.props.agentId
            const buffered = deletedAgentsRef.current.get(agentId)
            if (buffered) {
              // Re-link the shape mapping
              agentToShape.set(agentId, shape.id)
              // Restore agent on the server
              onRestoreAgent(buffered.agent, buffered.task)
              // Keep in buffer until sync confirms (cleared in main effect)
            }
          }
        }
      }
    }

    const unlisten = editor.store.listen(handleChange, { source: 'user', scope: 'document' })
    return unlisten
  }, [editor, onDeleteAgent, onRestoreAgent, agentsWithTasks])
}
