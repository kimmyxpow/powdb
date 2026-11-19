// Two stacked panes with a draggable separator between them. Sizes are percentages of the
// container height and live in component state (not persisted), so a remount starts at defaultTopSize.
import { useId, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import type { PaneLimits } from './split-math'
import { clampTopSize, topRange, topSizeFromKey, topSizeFromPointer } from './split-math'

interface SplitPaneProps {
  top: ReactNode
  bottom: ReactNode
  /** top pane size in percent; the bottom pane gets the rest. Also the size a double click restores. */
  defaultTopSize: number
  topLimits: PaneLimits
  bottomLimits: PaneLimits
  className?: string
}

interface DragState {
  pointerId: number
  box: DOMRect
  /** distance from the pointer to the separator's centre at pointer down */
  grab: number
}

export function SplitPane({ top, bottom, defaultTopSize, topLimits, bottomLimits, className }: SplitPaneProps) {
  const id = useId()
  const topId = `${id}-top`
  const bottomId = `${id}-bottom`
  const rootRef = useRef<HTMLDivElement>(null)
  const drag = useRef<DragState | null>(null)

  // Same markup on the server and in the first client render, so there is no layout jump.
  const defaultSize = clampTopSize(defaultTopSize, topLimits, bottomLimits)
  const [topSize, setTopSize] = useState(defaultSize)
  const [dragging, setDragging] = useState(false)
  const [hovering, setHovering] = useState(false)
  const range = topRange(topLimits, bottomLimits)

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const root = rootRef.current
    if (e.button !== 0 || !root) return
    e.preventDefault() // no text selection while dragging
    const handle = e.currentTarget
    handle.focus()
    handle.setPointerCapture(e.pointerId)
    const handleBox = handle.getBoundingClientRect()
    drag.current = {
      pointerId: e.pointerId,
      box: root.getBoundingClientRect(),
      grab: e.clientY - (handleBox.top + handleBox.height / 2),
    }
    setDragging(true)
  }

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    const next = topSizeFromPointer(e.clientY - d.grab, d.box.top, d.box.height, topLimits, bottomLimits)
    if (next !== null) setTopSize(next)
  }

  // the browser releases pointer capture after pointerup and pointercancel, so this ends every drag
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== e.pointerId) return
    drag.current = null
    setDragging(false)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = topSizeFromKey(e.key, topSize, topLimits, bottomLimits)
    if (next === null) return
    e.preventDefault()
    setTopSize(next)
  }

  const separatorState = dragging ? 'active' : hovering ? 'hover' : 'inactive'

  return (
    <div className={cn('flex min-h-0 flex-col', className)} ref={rootRef}>
      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden" id={topId} style={{ flex: `${topSize} 1 0px` }}>
        {top}
      </div>
      <div
        aria-controls={`${topId} ${bottomId}`}
        aria-orientation="horizontal"
        aria-valuemax={Math.round(range.max)}
        aria-valuemin={Math.round(range.min)}
        aria-valuenow={Math.round(topSize)}
        className="relative z-10 h-px shrink-0 touch-none bg-border outline-none after:absolute after:inset-x-0 after:-top-1.5 after:h-3 after:cursor-row-resize focus-visible:bg-ring data-[separator=active]:bg-ring data-[separator=hover]:bg-ring/60"
        data-separator={separatorState}
        onDoubleClick={() => setTopSize(defaultSize)}
        onKeyDown={onKeyDown}
        onLostPointerCapture={endDrag}
        onPointerDown={onPointerDown}
        onPointerEnter={() => setHovering(true)}
        onPointerLeave={() => setHovering(false)}
        onPointerMove={onPointerMove}
        role="separator"
        tabIndex={0}
      />
      <div
        className="flex min-h-0 min-w-0 flex-col overflow-hidden"
        id={bottomId}
        style={{ flex: `${100 - topSize} 1 0px` }}
      >
        {bottom}
      </div>
    </div>
  )
}
