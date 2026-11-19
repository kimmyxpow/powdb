import { MinusIcon, PlusIcon } from 'lucide-react'
import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from 'react'
import { Button } from '@/components/ui/button'
import type { SchemaDiagram } from '@/lib/diagram'
import { buildDiagramEdges, manyMarker, oneMarker, type DiagramEdge } from '@/lib/diagram-edges'
import { diagramBounds, placeNodes, type DiagramNode, type Point, type Positions } from '@/lib/diagram-layout'
import { DiagramMinimap } from './diagram-minimap'
import { TableNode } from './table-node'

const MIN_ZOOM = 0.1
const MAX_ZOOM = 2
const FIT_PADDING = 40
const DRAG_THRESHOLD = 3
const WHEEL_ZOOM_RATE = 0.002

interface View {
  x: number
  y: number
  k: number
}

export interface DiagramCanvasHandle {
  fit: () => void
  /** drops manual positions, re-runs the layout and fits */
  autoLayout: () => void
  /** selects nothing, centres the card at zoom 1 */
  centerOn: (id: string) => void
}

interface DiagramCanvasProps {
  ref?: Ref<DiagramCanvasHandle>
  connectionId: string
  database: string
  diagram: SchemaDiagram
  /** auto layout for the current column mode */
  autoNodes: DiagramNode[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onOpen: (schema: string, table: string) => void
}

type Gesture = {
  pointerId: number
  startX: number
  startY: number
  lastX: number
  lastY: number
  /** card under the pointer when the gesture started */
  nodeId: string | null
  /** the gesture started on a card header, so it moves the card */
  dragNode: boolean
  origin: Point | null
  moved: boolean
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))

/** Zoom by `factor`, keeping the diagram point under (px, py) fixed on screen. */
function zoomAround(v: View, factor: number, px: number, py: number): View {
  const k = clamp(v.k * factor, MIN_ZOOM, MAX_ZOOM)
  const ratio = k / v.k
  return { k, x: px - (px - v.x) * ratio, y: py - (py - v.y) * ratio }
}

const diagramLayoutKey = (connectionId: string, database: string, schema: string) =>
  `powview.diagram-layout:${connectionId}:${database}:${schema}`

/** Saved card positions, or null. Anything malformed is ignored. */
function readPositions(key: string): Positions | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const out: Positions = {}
    for (const [id, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue
      const { x, y } = value as { x?: unknown; y?: unknown }
      if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) {
        out[id] = { x, y }
      }
    }
    return Object.keys(out).length > 0 ? out : null
  } catch {
    return null
  }
}

function writePositions(key: string, positions: Positions | null): void {
  try {
    if (positions) window.localStorage.setItem(key, JSON.stringify(positions))
    else window.localStorage.removeItem(key)
  } catch {
    // storage can be unavailable (private mode, blocked site data); the arrangement just is not kept
  }
}

const toRecord = (nodes: DiagramNode[]): Positions => {
  const out: Positions = {}
  for (const n of nodes) out[n.id] = { x: n.x, y: n.y }
  return out
}

type EdgeTone = 'normal' | 'active' | 'dim'

interface EdgeViewProps {
  edge: DiagramEdge
  tone: EdgeTone
  onHover: (id: string | null) => void
}

const EdgeView = memo(
  function EdgeView({ edge, tone, onHover }: EdgeViewProps) {
    const color = tone === 'active' ? 'var(--primary)' : 'var(--muted-foreground)'
    const opacity = tone === 'active' ? 1 : tone === 'dim' ? 0.12 : 0.6
    const width = tone === 'active' ? 1.75 : 1.25
    return (
      <g style={{ color, opacity }}>
        <path
          d={edge.path}
          data-from={`${edge.fromTable}.${edge.fromColumn}`}
          data-to={`${edge.toTable}.${edge.toColumn}`}
          data-fk={edge.fk}
          data-x1={edge.from.x}
          data-y1={edge.from.y}
          data-x2={edge.to.x}
          data-y2={edge.to.y}
          fill="none"
          stroke="currentColor"
          strokeWidth={width}
        />
        {/* wide transparent stroke so thin edges are easy to hover */}
        <path
          aria-hidden="true"
          d={edge.path}
          data-edge-hit=""
          fill="none"
          onPointerEnter={() => onHover(edge.id)}
          onPointerLeave={() => onHover(null)}
          pointerEvents="stroke"
          stroke="transparent"
          strokeWidth={12}
        />
        {manyMarker(edge.from, edge.fromSide).map((points) => (
          <polyline key={points} fill="none" points={points} stroke="currentColor" strokeWidth={width} />
        ))}
        <polygon fill="currentColor" points={oneMarker(edge.to, edge.toSide)} />
      </g>
    )
  },
  (a, b) =>
    a.edge.id === b.edge.id &&
    a.edge.path === b.edge.path &&
    a.edge.fromSide === b.edge.fromSide &&
    a.edge.toSide === b.edge.toSide &&
    a.edge.from.x === b.edge.from.x &&
    a.edge.from.y === b.edge.from.y &&
    a.edge.to.x === b.edge.to.x &&
    a.edge.to.y === b.edge.to.y &&
    a.tone === b.tone,
)

export function DiagramCanvas({
  ref,
  connectionId,
  database,
  diagram,
  autoNodes,
  selectedId,
  onSelect,
  onOpen,
}: DiagramCanvasProps) {
  const storageKey = diagramLayoutKey(connectionId, database, diagram.schema)
  const viewportRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 })
  const viewRef = useRef(view)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [hoverEdge, setHoverEdge] = useState<string | null>(null)
  // manual card positions; null = the auto layout is in use
  const [manual, setManual] = useState<Positions | null>(() => readPositions(storageKey))
  const manualRef = useRef(manual)

  const placed = placeNodes(autoNodes, manual)
  const placedRef = useRef(placed)
  useEffect(() => {
    placedRef.current = placed
  })

  const placedById = new Map(placed.map((n) => [n.id, n]))
  const edges = buildDiagramEdges(placed, diagram)

  // the selected card and the cards it has a foreign key with; null when nothing is selected
  let related: Set<string> | null = null
  if (selectedId) {
    related = new Set([selectedId])
    for (const e of edges) {
      if (e.fromTable === selectedId || e.toTable === selectedId) {
        related.add(e.fromTable)
        related.add(e.toTable)
      }
    }
  }

  // ---- view: pan and zoom, flushed once per frame for continuous input ----
  const viewFrame = useRef<number | null>(null)
  const scheduleView = useCallback(() => {
    if (viewFrame.current !== null) return
    viewFrame.current = requestAnimationFrame(() => {
      viewFrame.current = null
      setView(viewRef.current)
    })
  }, [])

  const setViewNow = (next: View) => {
    viewRef.current = next
    setView(next)
  }

  const fitTo = (nodes: DiagramNode[]) => {
    const el = viewportRef.current
    const b = diagramBounds(nodes)
    if (!el || !b) return
    const w = el.clientWidth
    const h = el.clientHeight
    if (w <= 0 || h <= 0) return
    const k = clamp(
      Math.min((w - 2 * FIT_PADDING) / Math.max(b.width, 1), (h - 2 * FIT_PADDING) / Math.max(b.height, 1), 1),
      MIN_ZOOM,
      MAX_ZOOM,
    )
    setViewNow({ k, x: (w - b.width * k) / 2 - b.x * k, y: (h - b.height * k) / 2 - b.y * k })
  }

  const zoomBy = (factor: number) => {
    const el = viewportRef.current
    if (!el) return
    setViewNow(zoomAround(viewRef.current, factor, el.clientWidth / 2, el.clientHeight / 2))
  }

  // a point of the diagram (in diagram units) goes to the centre of the viewport
  const centreOnPoint = (wx: number, wy: number, k: number) => {
    const el = viewportRef.current
    if (!el) return
    setViewNow({ k, x: el.clientWidth / 2 - wx * k, y: el.clientHeight / 2 - wy * k })
  }

  const panToPoint = (wx: number, wy: number) => {
    const el = viewportRef.current
    if (!el) return
    const k = viewRef.current.k
    viewRef.current = { k, x: el.clientWidth / 2 - wx * k, y: el.clientHeight / 2 - wy * k }
    scheduleView()
  }

  // ---- manual positions: committed synchronously, flushed once per frame while dragging ----
  const commitManual = (next: Positions | null) => {
    manualRef.current = next
    setManual(next)
  }

  const dragFrame = useRef<number | null>(null)
  const pendingDrag = useRef<{ id: string; pos: Point } | null>(null)
  const flushDrag = () => {
    if (dragFrame.current !== null) {
      cancelAnimationFrame(dragFrame.current)
      dragFrame.current = null
    }
    const pending = pendingDrag.current
    if (!pending) return
    pendingDrag.current = null
    commitManual({ ...(manualRef.current ?? toRecord(placedRef.current)), [pending.id]: pending.pos })
  }

  const scheduleDrag = (id: string, pos: Point) => {
    pendingDrag.current = { id, pos }
    if (dragFrame.current === null) {
      dragFrame.current = requestAnimationFrame(() => {
        dragFrame.current = null
        flushDrag()
      })
    }
  }

  // ---- imperative API for the toolbar ----
  const autoLayout = () => {
    commitManual(null)
    writePositions(storageKey, null)
    fitTo(autoNodes)
  }

  useImperativeHandle(ref, () => ({
    fit: () => fitTo(placedRef.current),
    autoLayout,
    centerOn: (id: string) => {
      const node = placedRef.current.find((n) => n.id === id)
      if (node) centreOnPoint(node.x + node.width / 2, node.y + node.height / 2, 1)
    },
  }))

  // ---- mount: measure, fit once, and keep the size up to date ----
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const update = () => setSize({ width: el.clientWidth, height: el.clientHeight })
    update()
    fitTo(placedRef.current)
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
    // fit only on mount; later changes use the buttons
  }, [])

  // wheel: plain wheel pans, Ctrl/Cmd + wheel (and trackpad pinch) zooms around the cursor
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
      const dx = e.deltaX * unit
      const dy = e.deltaY * unit
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect()
        viewRef.current = zoomAround(
          viewRef.current,
          Math.exp(-dy * WHEEL_ZOOM_RATE),
          e.clientX - rect.left,
          e.clientY - rect.top,
        )
      } else {
        const v = viewRef.current
        viewRef.current = { ...v, x: v.x - dx, y: v.y - dy }
      }
      scheduleView()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [scheduleView])

  useEffect(
    () => () => {
      if (viewFrame.current !== null) cancelAnimationFrame(viewFrame.current)
      if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current)
    },
    [],
  )

  // ---- pointer gestures (delegated: one handler for all cards) ----
  const gestureRef = useRef<Gesture | null>(null)

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const target = e.target as Element
    if (target.closest('button, input, [data-canvas-control]')) return
    const card = target.closest<HTMLElement>('[data-node]')
    const nodeId = card?.dataset.node ?? null
    const node = nodeId ? placedById.get(nodeId) : undefined
    const header = target.closest('[data-node-header]')
    gestureRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      nodeId: node ? nodeId : null,
      dragNode: Boolean(node && header),
      origin: node ? { x: node.x, y: node.y } : null,
      moved: false,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gestureRef.current
    if (!g || e.pointerId !== g.pointerId) return
    const dx = e.clientX - g.startX
    const dy = e.clientY - g.startY
    if (!g.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      g.moved = true
    }
    if (g.dragNode && g.origin && g.nodeId) {
      const k = viewRef.current.k
      scheduleDrag(g.nodeId, { x: g.origin.x + dx / k, y: g.origin.y + dy / k })
    } else {
      const v = viewRef.current
      viewRef.current = { ...v, x: v.x + (e.clientX - g.lastX), y: v.y + (e.clientY - g.lastY) }
      scheduleView()
    }
    g.lastX = e.clientX
    g.lastY = e.clientY
  }

  const endGesture = (e: ReactPointerEvent<HTMLDivElement>, select: boolean) => {
    const g = gestureRef.current
    if (!g || e.pointerId !== g.pointerId) return
    gestureRef.current = null
    if (g.dragNode && g.moved) {
      flushDrag()
      writePositions(storageKey, manualRef.current)
    }
    if (!select) return
    if (g.nodeId) {
      if (!g.moved || g.dragNode) onSelect(g.nodeId)
    } else if (!g.moved) {
      onSelect(null)
    }
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === '+' || e.key === '=') {
      e.preventDefault()
      zoomBy(1.2)
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault()
      zoomBy(1 / 1.2)
    } else if (e.key === '0') {
      e.preventDefault()
      fitTo(placedRef.current)
    } else if (e.key === 'Escape') {
      onSelect(null)
    }
  }

  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const target = e.target as Element
    if (target.closest('button') || !target.closest('[data-node-header]')) return
    const id = target.closest<HTMLElement>('[data-node]')?.dataset.node
    const node = id ? placedById.get(id) : undefined
    if (node) onOpen(node.schema, node.name)
  }

  const tone = (edge: DiagramEdge): EdgeTone => {
    if (edge.id === hoverEdge) return 'active'
    if (selectedId) return edge.fromTable === selectedId || edge.toTable === selectedId ? 'active' : 'dim'
    return 'normal'
  }

  const hovered = hoverEdge ? edges.find((e) => e.id === hoverEdge) : undefined
  const label = (id: string, column: string) => {
    const n = placedById.get(id)
    const table = n && n.schema !== diagram.schema ? `${n.schema}.${n.name}` : (n?.name ?? id)
    return `${table}.${column}`
  }

  const dot = 20 * view.k
  const bounds = diagramBounds(placed)

  return (
    <div
      aria-label="Schema diagram. Drag to pan, Ctrl or Cmd with the wheel to zoom, plus and minus keys to zoom, 0 to fit."
      className="absolute inset-0 touch-none select-none overflow-hidden bg-background outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      onPointerCancel={(e) => endGesture(e, false)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endGesture(e, true)}
      ref={viewportRef}
      role="group"
      style={{
        backgroundImage:
          'radial-gradient(circle, color-mix(in srgb, var(--muted-foreground) 40%, transparent) 1px, transparent 1.5px)',
        backgroundSize: `${dot}px ${dot}px`,
        backgroundPosition: `${view.x}px ${view.y}px`,
      }}
      tabIndex={0}
    >
      <div
        className="absolute top-0 left-0"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, transformOrigin: '0 0' }}
      >
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute top-0 left-0 overflow-visible"
          height={1}
          width={1}
        >
          {edges.map((edge) => (
            <EdgeView edge={edge} key={edge.id} onHover={setHoverEdge} tone={tone(edge)} />
          ))}
        </svg>

        {autoNodes.map((node) => {
          const p = placedById.get(node.id)!
          return (
            <TableNode
              dimmed={related !== null && !related.has(node.id)}
              key={node.id}
              node={node}
              onOpen={onOpen}
              selected={node.id === selectedId}
              x={p.x}
              y={p.y}
            />
          )
        })}
      </div>

      {hovered && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border bg-popover px-2 py-1 text-popover-foreground text-xs shadow-md"
          style={{ left: view.x + hovered.mid.x * view.k, top: view.y + hovered.mid.y * view.k - 8 }}
        >
          <div className="whitespace-nowrap font-mono">
            {label(hovered.fromTable, hovered.fromColumn)} → {label(hovered.toTable, hovered.toColumn)}
          </div>
          <div className="whitespace-nowrap text-muted-foreground">{hovered.fk}</div>
        </div>
      )}

      {bounds && (
        <div
          className="absolute bottom-3 left-3 z-10 flex flex-col items-center gap-1 rounded-lg border bg-card p-1 shadow-sm"
          data-canvas-control=""
        >
          <Button aria-label="Zoom in" onClick={() => zoomBy(1.2)} size="icon-sm" title="Zoom in" variant="ghost">
            <PlusIcon />
          </Button>
          <span className="w-full text-center text-muted-foreground text-xs tabular-nums">
            {Math.round(view.k * 100)}%
          </span>
          <Button aria-label="Zoom out" onClick={() => zoomBy(1 / 1.2)} size="icon-sm" title="Zoom out" variant="ghost">
            <MinusIcon />
          </Button>
        </div>
      )}

      {bounds && <DiagramMinimap bounds={bounds} nodes={placed} onPan={panToPoint} size={size} view={view} />}
    </div>
  )
}
