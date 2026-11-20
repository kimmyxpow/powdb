import type { DiagramColumn, DiagramTable, SchemaDiagram } from './diagram'
import type { RelationKind } from './types'

// Card geometry in diagram units (px at zoom 1). Edge anchors are computed from these,
// so table-node.tsx must render headers and rows at exactly these heights.
export const CARD_HEADER_HEIGHT = 32
export const CARD_ROW_HEIGHT = 22
const CARD_BOTTOM_PADDING = 6
export const CARD_MIN_WIDTH = 200
export const CARD_MAX_WIDTH = 320

const RANK_GAP = 120
const ROW_GAP = 40
const GRID_GAP = 40
const GRID_OFFSET = 80
const SWEEPS = 4

type DiagramNodeKind = RelationKind | 'ghost'
export type Side = 'left' | 'right'
export interface Point {
  x: number
  y: number
}
/** Card positions by node id (`schema.table`), in diagram units. */
export type Positions = Record<string, Point>

export interface DiagramNode {
  /** `schema.table`, unique within a diagram (ghost nodes use their own schema) */
  id: string
  schema: string
  name: string
  /** 'ghost' = referenced by an FK but not a table of this schema; shows only referenced columns */
  kind: DiagramNodeKind
  estimatedRows: number | null
  /** rows shown on the card, in display order */
  columns: DiagramColumn[]
  /** columns left out by the keys-only filter */
  hiddenColumns: number
  x: number
  y: number
  width: number
  height: number
}

export const nodeIdOf = (schema: string, name: string): string => `${schema}.${name}`

const pairKey = (a: string, b: string): string => `${a}\u0000${b}`

/** Card height for a given number of visible rows (plus the "+N more" footer when columns are hidden). */
function cardHeight(rows: number, hasFooter: boolean): number {
  return CARD_HEADER_HEIGHT + CARD_ROW_HEIGHT * rows + (hasFooter ? CARD_ROW_HEIGHT : 0) + CARD_BOTTOM_PADDING
}

/**
 * Card width from the longest title and column line (rough monospace metrics), clamped to 200..320.
 * Long names are truncated on the card; the clamp keeps the layout stable.
 */
function cardWidth(schema: string, name: string, kind: DiagramNodeKind, columns: DiagramColumn[]): number {
  const title = (kind === 'ghost' ? schema.length + 1 : 0) + name.length
  // padding, icon, gap, title, gap, open button, padding
  let widest = 8 + 14 + 8 + title * 7.6 + 4 + 24 + 8
  for (const c of columns) {
    // padding, key icon, gap, name (mono), gap, type (mono), padding
    widest = Math.max(widest, 10 + 12 + 6 + c.name.length * 7.2 + 12 + c.type.length * 6.6 + 10)
  }
  return Math.min(CARD_MAX_WIDTH, Math.max(CARD_MIN_WIDTH, Math.ceil(widest)))
}

function makeNode(partial: Omit<DiagramNode, 'width' | 'height' | 'x' | 'y'>): DiagramNode {
  const hasFooter = partial.hiddenColumns > 0
  return {
    ...partial,
    x: 0,
    y: 0,
    width: cardWidth(partial.schema, partial.name, partial.kind, partial.columns),
    height: cardHeight(partial.columns.length, hasFooter),
  }
}

/** Anchor of a column row's left or right edge, in diagram units. Null when the column is not shown. */
export function anchorFor(
  node: Pick<DiagramNode, 'x' | 'y' | 'width' | 'columns'>,
  columnName: string,
  side: Side,
): Point | null {
  const index = node.columns.findIndex((c) => c.name === columnName)
  if (index < 0) return null
  return {
    x: side === 'right' ? node.x + node.width : node.x,
    y: node.y + CARD_HEADER_HEIGHT + index * CARD_ROW_HEIGHT + CARD_ROW_HEIGHT / 2,
  }
}

/**
 * Auto layout of one schema: left-to-right ranks (a referenced table sits left of the tables that
 * reference it), barycenter ordering inside each rank, and isolated tables in a grid below.
 * Pure and deterministic: the same diagram and options always give the same positions.
 */
export function layoutSchemaDiagram(diagram: SchemaDiagram, options: { showAllColumns?: boolean } = {}): DiagramNode[] {
  const showAllColumns = options.showAllColumns ?? true

  const realTables = new Map<string, DiagramTable>()
  for (const t of diagram.tables) realTables.set(nodeIdOf(diagram.schema, t.name), t)

  // Only FKs whose source is a table of this diagram (the server already guarantees this).
  const fks = diagram.foreignKeys.filter((fk) => realTables.has(nodeIdOf(diagram.schema, fk.fromTable)))

  // Columns that must stay visible in keys mode: PK, FK, and both ends of every FK column pair.
  const keyNames = new Map<string, Set<string>>()
  const ghosts = new Map<string, { schema: string; name: string; columns: string[] }>()
  const linked = new Set<string>()
  const addKeys = (id: string, names: string[]) => {
    const set = keyNames.get(id) ?? new Set<string>()
    for (const n of names) set.add(n)
    keyNames.set(id, set)
  }
  for (const fk of fks) {
    const source = nodeIdOf(diagram.schema, fk.fromTable)
    const target = nodeIdOf(fk.toSchema, fk.toTable)
    linked.add(source)
    linked.add(target)
    addKeys(source, fk.fromColumns)
    if (realTables.has(target)) {
      addKeys(target, fk.toColumns)
    } else {
      const ghost = ghosts.get(target) ?? { schema: fk.toSchema, name: fk.toTable, columns: [] }
      for (const c of fk.toColumns) if (!ghost.columns.includes(c)) ghost.columns.push(c)
      ghosts.set(target, ghost)
    }
  }

  const byId = new Map<string, DiagramNode>()
  for (const t of diagram.tables) {
    const id = nodeIdOf(diagram.schema, t.name)
    if (byId.has(id)) continue
    const keys = keyNames.get(id)
    const columns = showAllColumns
      ? t.columns
      : t.columns.filter((c) => c.isPrimaryKey || c.isForeignKey || (keys?.has(c.name) ?? false))
    byId.set(
      id,
      makeNode({
        id,
        schema: diagram.schema,
        name: t.name,
        kind: t.kind,
        estimatedRows: t.estimatedRows,
        columns,
        hiddenColumns: t.columns.length - columns.length,
      }),
    )
  }
  for (const [id, ghost] of ghosts) {
    if (byId.has(id)) continue
    const columns: DiagramColumn[] = ghost.columns.map((name) => ({
      name,
      type: '',
      nullable: true,
      isPrimaryKey: false,
      isForeignKey: false,
    }))
    byId.set(
      id,
      makeNode({
        id,
        schema: ghost.schema,
        name: ghost.name,
        kind: 'ghost',
        estimatedRows: null,
        columns,
        hiddenColumns: 0,
      }),
    )
  }

  const ids = [...byId.keys()].sort()

  // Ranking uses referenced -> referencing links. Self references are ignored here.
  const links: Array<[string, string]> = []
  const seenLinks = new Set<string>()
  const neighbors = new Map<string, Set<string>>()
  const addNeighbor = (a: string, b: string) => {
    const set = neighbors.get(a) ?? new Set<string>()
    set.add(b)
    neighbors.set(a, set)
  }
  for (const fk of fks) {
    const source = nodeIdOf(diagram.schema, fk.fromTable)
    const target = nodeIdOf(fk.toSchema, fk.toTable)
    if (source === target) continue
    addNeighbor(source, target)
    addNeighbor(target, source)
    if (seenLinks.has(pairKey(target, source))) continue
    seenLinks.add(pairKey(target, source))
    links.push([target, source])
  }

  const connectedIds = ids.filter((id) => linked.has(id))
  const isolatedIds = ids.filter((id) => !linked.has(id))

  const rank = rankNodes(connectedIds, links)
  const maxRank = connectedIds.reduce((m, id) => Math.max(m, rank.get(id) ?? 0), 0)
  const layers: string[][] = Array.from({ length: connectedIds.length ? maxRank + 1 : 0 }, () => [])
  for (const id of connectedIds) layers[rank.get(id) ?? 0]!.push(id)
  orderLayers(layers, rank, neighbors)

  const positions = new Map<string, Point>()
  const layerHeights = layers.map((layer) =>
    layer.reduce((sum, id, i) => sum + byId.get(id)!.height + (i > 0 ? ROW_GAP : 0), 0),
  )
  const blockHeight = layerHeights.reduce((m, h) => Math.max(m, h), 0)
  let x = 0
  layers.forEach((layer, r) => {
    let colWidth = 0
    let y = (blockHeight - layerHeights[r]!) / 2
    for (const id of layer) {
      const node = byId.get(id)!
      positions.set(id, { x, y })
      colWidth = Math.max(colWidth, node.width)
      y += node.height + ROW_GAP
    }
    x += colWidth + RANK_GAP
  })

  // Tables without any FK: compact grid below the connected block, sorted by name.
  const isolated = [...isolatedIds].sort((a, b) => {
    const na = byId.get(a)!.name
    const nb = byId.get(b)!.name
    return na < nb ? -1 : na > nb ? 1 : a < b ? -1 : a > b ? 1 : 0
  })
  if (isolated.length > 0) {
    const perRow = Math.max(1, Math.ceil(Math.sqrt(isolated.length)))
    let rowTop = connectedIds.length > 0 ? blockHeight + GRID_OFFSET : 0
    for (let start = 0; start < isolated.length; start += perRow) {
      const row = isolated.slice(start, start + perRow)
      let rowHeight = 0
      let colX = 0
      for (const id of row) {
        const node = byId.get(id)!
        positions.set(id, { x: colX, y: rowTop })
        colX += node.width + GRID_GAP
        rowHeight = Math.max(rowHeight, node.height)
      }
      rowTop += rowHeight + GRID_GAP
    }
  }

  return ids.map((id) => {
    const p = positions.get(id) ?? { x: 0, y: 0 }
    return { ...byId.get(id)!, x: p.x, y: p.y }
  })
}

/**
 * Longest-path ranks over referenced -> referencing links. Cycles are broken by dropping the
 * DFS back edges, so the remaining graph is acyclic and every node gets a finite rank.
 */
function rankNodes(ids: string[], links: Array<[string, string]>): Map<string, number> {
  const out = new Map<string, string[]>()
  const indegree = new Map<string, number>()
  for (const id of ids) {
    out.set(id, [])
    indegree.set(id, 0)
  }
  for (const [a, b] of links) out.get(a)!.push(b)
  for (const list of out.values()) list.sort()

  const state = new Map<string, 'open' | 'done'>()
  const back = new Set<string>()
  const visit = (u: string) => {
    state.set(u, 'open')
    for (const v of out.get(u)!) {
      const s = state.get(v)
      if (s === 'open') back.add(pairKey(u, v))
      else if (s === undefined) visit(v)
    }
    state.set(u, 'done')
  }
  for (const id of ids) if (!state.has(id)) visit(id)

  for (const [a, b] of links) {
    if (!back.has(pairKey(a, b))) indegree.set(b, indegree.get(b)! + 1)
  }

  const rank = new Map<string, number>(ids.map((id) => [id, 0]))
  const queue = ids.filter((id) => indegree.get(id) === 0)
  for (let i = 0; i < queue.length; i++) {
    const u = queue[i]!
    for (const v of out.get(u)!) {
      if (back.has(pairKey(u, v))) continue
      rank.set(v, Math.max(rank.get(v)!, rank.get(u)! + 1))
      const left = indegree.get(v)! - 1
      indegree.set(v, left)
      if (left === 0) queue.push(v)
    }
  }
  return rank
}

/** Reorders each rank by the average position of its neighbours, sweeping down and up. */
function orderLayers(layers: string[][], rank: Map<string, number>, neighbors: Map<string, Set<string>>): void {
  const pos = new Map<string, number>()
  layers.forEach((layer) => layer.forEach((id, i) => pos.set(id, i)))

  const sortLayer = (r: number, towardsLeft: boolean) => {
    const layer = layers[r]!
    const key = new Map<string, number>()
    for (const id of layer) {
      const near = [...(neighbors.get(id) ?? [])].filter((n) =>
        towardsLeft ? (rank.get(n) ?? 0) < r : (rank.get(n) ?? 0) > r,
      )
      const current = pos.get(id)!
      key.set(id, near.length === 0 ? current : near.reduce((s, n) => s + (pos.get(n) ?? 0), 0) / near.length)
    }
    layer.sort((a, b) => key.get(a)! - key.get(b)! || pos.get(a)! - pos.get(b)! || (a < b ? -1 : a > b ? 1 : 0))
    layer.forEach((id, i) => pos.set(id, i))
  }

  const last = layers.length - 1
  for (let s = 0; s < SWEEPS; s++) {
    for (let r = 1; r <= last; r++) sortLayer(r, true)
    for (let r = last - 1; r >= 0; r--) sortLayer(r, false)
  }
}

/**
 * Applies saved (manually moved) positions. Nodes without a saved position, such as tables
 * added after the arrangement was saved, are stacked to the right of the saved block so the
 * user's cards never move. With no saved positions the auto layout is returned unchanged.
 */
export function placeNodes(nodes: DiagramNode[], manual: Positions | null): DiagramNode[] {
  if (!manual) return nodes
  const saved = nodes.filter((n) => manual[n.id])
  if (saved.length === 0) return nodes

  let right = Number.NEGATIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  for (const n of saved) {
    const p = manual[n.id]!
    right = Math.max(right, p.x + n.width)
    top = Math.min(top, p.y)
  }

  const fresh = nodes.filter((n) => !manual[n.id]).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const freshPos = new Map<string, Point>()
  let y = top
  for (const n of fresh) {
    freshPos.set(n.id, { x: right + RANK_GAP, y })
    y += n.height + ROW_GAP
  }

  return nodes.map((n) => {
    const p = manual[n.id] ?? freshPos.get(n.id) ?? { x: n.x, y: n.y }
    return p.x === n.x && p.y === n.y ? n : { ...n, x: p.x, y: p.y }
  })
}

/** Bounding box of the cards, or null when there are none. */
export function diagramBounds(nodes: DiagramNode[]): { x: number; y: number; width: number; height: number } | null {
  if (nodes.length === 0) return null
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const n of nodes) {
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + n.width)
    maxY = Math.max(maxY, n.y + n.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The diagram-space rectangle a viewport shows, grown by half its size on every side so cards
 * are mounted before they scroll in. Null while the viewport has no size yet (render everything).
 */
export function visibleRect(
  view: { x: number; y: number; k: number },
  size: { width: number; height: number },
): Rect | null {
  if (size.width <= 0 || size.height <= 0) return null
  const w = size.width / view.k
  const h = size.height / view.k
  return { x: -view.x / view.k - w / 2, y: -view.y / view.k - h / 2, width: w * 2, height: h * 2 }
}

/** True when the two boxes overlap (touching edges do not count). */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}
