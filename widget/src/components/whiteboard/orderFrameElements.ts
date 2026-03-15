import type { Editor } from 'tldraw'

/**
 * Auto-layout children inside a frame in a grid.
 * Also resizes the frame to fit all children.
 */
export function orderFrameElements(editor: Editor, frameShape: ReturnType<Editor['getShape']>) {
  if (!frameShape) return

  const childIds = editor.getSortedChildIdsForParent(frameShape.id)
  if (childIds.length === 0) return

  const children = childIds
    .map(id => editor.getShape(id))
    .filter((s): s is NonNullable<typeof s> => s != null)

  if (children.length === 0) return

  const padding = 20
  const gap = 16
  const titleBarH = 32

  // Get each child's size
  const childSizes = children.map(child => {
    const bounds = editor.getShapeGeometry(child).bounds
    return { id: child.id, type: child.type, w: bounds.w, h: bounds.h }
  })

  // Calculate grid layout: use 3 columns max
  const maxChildW = Math.max(...childSizes.map(c => c.w))
  const cols = Math.min(children.length, 3)

  // Lay out in grid rows
  const updates: Array<{ id: typeof children[0]['id']; type: string; x: number; y: number }> = []
  let col = 0
  let rowHeight = 0
  let y = padding

  for (const child of childSizes) {
    if (col >= cols) {
      col = 0
      y += rowHeight + gap
      rowHeight = 0
    }

    const x = padding + col * (maxChildW + gap)
    updates.push({ id: child.id, type: 'geo', x, y })
    rowHeight = Math.max(rowHeight, child.h)
    col++
  }

  editor.updateShapes(updates as any)

  // Resize frame to fit children
  const frameW = padding * 2 + cols * maxChildW + (cols - 1) * gap
  const frameH = y + rowHeight + padding + titleBarH
  editor.updateShape({
    id: frameShape.id,
    type: 'frame',
    props: { w: frameW, h: frameH },
  } as any)
}
