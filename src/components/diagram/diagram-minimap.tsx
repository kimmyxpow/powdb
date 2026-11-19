import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import type { DiagramNode } from '@/lib/diagram-layout'

const MINI_WIDTH = 200
const MINI_HEIGHT = 140
const MARGIN = 40

interface DiagramMinimapProps {
  nodes: DiagramNode[]
  bounds: { x: number; y: number; width: number; height: number }
  view: { x: number; y: number; k: number }
  size: { width: number; height: number }
  /** pans so that the diagram point (x, y) is at the centre of the viewport */
  onPan: (x: number, y: number) => void
}

/** Overview of all cards with the visible area as a rectangle. Click or drag to pan. Hidden below sm. */
export function DiagramMinimap({ nodes, bounds, view, size, onPan }: DiagramMinimapProps) {
  const dragging = useRef(false)

  const k = view.k
  const vx = -view.x / k
  const vy = -view.y / k
  const vw = size.width / k
  const vh = size.height / k
  const minX = Math.min(bounds.x, vx) - MARGIN
  const minY = Math.min(bounds.y, vy) - MARGIN
  const maxX = Math.max(bounds.x + bounds.width, vx + vw) + MARGIN
  const maxY = Math.max(bounds.y + bounds.height, vy + vh) + MARGIN
  const width = maxX - minX
  const height = maxY - minY
  const scale = Math.min(MINI_WIDTH / width, MINI_HEIGHT / height)

  const toWorld = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: minX + (e.clientX - rect.left) / scale, y: minY + (e.clientY - rect.top) / scale }
  }

  const onDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return
    dragging.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = toWorld(e)
    onPan(p.x, p.y)
  }

  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!dragging.current) return
    const p = toWorld(e)
    onPan(p.x, p.y)
  }

  const onUp = () => {
    dragging.current = false
  }

  return (
    <div
      className="absolute right-3 bottom-3 z-10 hidden items-center justify-center overflow-hidden rounded-lg border bg-card shadow-sm sm:flex"
      data-canvas-control=""
      style={{ width: MINI_WIDTH, height: MINI_HEIGHT }}
    >
      <svg
        aria-label="Overview. Click or drag to move the view."
        className="cursor-pointer touch-none"
        height={height * scale}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        role="img"
        viewBox={`${minX} ${minY} ${width} ${height}`}
        width={width * scale}
      >
        <rect fill="var(--background)" height={height} width={width} x={minX} y={minY} />
        {nodes.map((n) => (
          <rect
            fill="var(--muted-foreground)"
            fillOpacity={0.45}
            height={n.height}
            key={n.id}
            width={n.width}
            x={n.x}
            y={n.y}
          />
        ))}
        <rect
          fill="var(--primary)"
          fillOpacity={0.08}
          height={vh}
          stroke="var(--primary)"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
          width={vw}
          x={vx}
          y={vy}
        />
      </svg>
    </div>
  )
}
