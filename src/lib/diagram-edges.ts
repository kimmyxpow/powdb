import type { SchemaDiagram } from './diagram'
import { anchorFor, nodeIdOf, type DiagramNode, type Point, type Rect, type Side } from './diagram-layout'

export interface DiagramEdge {
  id: string
  fk: string
  /** node ids (`schema.table`) */
  fromTable: string
  fromColumn: string
  toTable: string
  toColumn: string
  /** SVG path in diagram units, from the FK row to the referenced row */
  path: string
  from: Point
  to: Point
  fromSide: Side
  toSide: Side
  /** point at the middle of the curve, for the hover label */
  mid: Point
  /** box around the curve and its markers, for culling */
  bounds: Rect
}

// Loops stay outside the cards; curves reach out this far before turning.
const LOOP_REACH = 28
const LOOP_EXTRA_MAX = 60
const CURVE_MIN = 32
const CURVE_MAX = 160
// crow's foot and hit stroke reach a little past the curve
const EDGE_PAD = 12

const outward = (side: Side): number => (side === 'right' ? 1 : -1)
const round = (n: number): number => Math.round(n * 100) / 100

/**
 * Picks the card sides for one FK. Fully right: leave the source's right edge, enter the target's
 * left edge. Fully left: the opposite. Otherwise (overlap or self reference) both ends use the
 * right side and the curve loops outward.
 */
export function chooseSides(
  source: Pick<DiagramNode, 'id' | 'x' | 'width'>,
  target: Pick<DiagramNode, 'id' | 'x' | 'width'>,
): { fromSide: Side; toSide: Side; loop: boolean } {
  if (source.id === target.id) return { fromSide: 'right', toSide: 'right', loop: true }
  if (target.x >= source.x + source.width) return { fromSide: 'right', toSide: 'left', loop: false }
  if (target.x + target.width <= source.x) return { fromSide: 'left', toSide: 'right', loop: false }
  return { fromSide: 'right', toSide: 'right', loop: true }
}

/**
 * One edge per column pair of each FK (composite keys give several edges, all with the same
 * `fk` name). Endpoints are the exact middle of the column rows, on the card border.
 */
export function buildDiagramEdges(nodes: DiagramNode[], diagram: SchemaDiagram): DiagramEdge[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const edges: DiagramEdge[] = []
  const usedIds = new Set<string>()

  for (const fk of diagram.foreignKeys) {
    const source = byId.get(nodeIdOf(diagram.schema, fk.fromTable))
    const target = byId.get(nodeIdOf(fk.toSchema, fk.toTable))
    if (!source || !target) continue
    const { fromSide, toSide, loop } = chooseSides(source, target)

    const pairs = Math.min(fk.fromColumns.length, fk.toColumns.length)
    for (let i = 0; i < pairs; i++) {
      const fromColumn = fk.fromColumns[i]!
      const toColumn = fk.toColumns[i]!
      const from = anchorFor(source, fromColumn, fromSide)
      const to = anchorFor(target, toColumn, toSide)
      if (!from || !to) continue

      let id = `${fk.name}:${source.id}.${fromColumn}>${target.id}.${toColumn}`
      if (usedIds.has(id)) id = `${id}#${i}`
      usedIds.add(id)

      const { path, mid, bounds } = curve(from, fromSide, to, toSide, loop)
      edges.push({
        id,
        fk: fk.name,
        fromTable: source.id,
        fromColumn,
        toTable: target.id,
        toColumn,
        path,
        from,
        to,
        fromSide,
        toSide,
        mid,
        bounds,
      })
    }
  }
  return edges
}

function curve(
  from: Point,
  fromSide: Side,
  to: Point,
  toSide: Side,
  loop: boolean,
): { path: string; mid: Point; bounds: Rect } {
  const o1 = outward(fromSide)
  const o2 = outward(toSide)
  let c1: Point
  let c2: Point
  if (loop) {
    const reach = LOOP_REACH + Math.min(Math.abs(to.y - from.y) * 0.25, LOOP_EXTRA_MAX)
    c1 = { x: from.x + o1 * reach, y: from.y }
    c2 = { x: to.x + o2 * reach, y: to.y }
  } else {
    // horizontal tangents at both ends; the handle length follows the horizontal distance
    const k = Math.min(CURVE_MAX, Math.max(CURVE_MIN, Math.abs(to.x - from.x) * 0.5))
    c1 = { x: from.x + o1 * k, y: from.y }
    c2 = { x: to.x + o2 * k, y: to.y }
  }
  const path = `M ${round(from.x)} ${round(from.y)} C ${round(c1.x)} ${round(c1.y)}, ${round(c2.x)} ${round(c2.y)}, ${round(to.x)} ${round(to.y)}`
  const mid = {
    x: (from.x + 3 * c1.x + 3 * c2.x + to.x) / 8,
    y: (from.y + 3 * c1.y + 3 * c2.y + to.y) / 8,
  }
  // a cubic lies inside the hull of its four points
  const x0 = Math.min(from.x, c1.x, c2.x, to.x) - EDGE_PAD
  const y0 = Math.min(from.y, c1.y, c2.y, to.y) - EDGE_PAD
  const x1 = Math.max(from.x, c1.x, c2.x, to.x) + EDGE_PAD
  const y1 = Math.max(from.y, c1.y, c2.y, to.y) + EDGE_PAD
  return { path, mid, bounds: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } }
}

/**
 * Crow's foot at the FK end ("many"): the three toes touch the card border and meet on the
 * line a little outside it, so it never reads as an arrow into the card.
 * Returned as polyline point lists.
 */
export function manyMarker(at: Point, side: Side): string[] {
  const o = outward(side) * 9
  const spread = 5
  return [
    `${round(at.x)},${round(at.y - spread)} ${round(at.x + o)},${round(at.y)} ${round(at.x)},${round(at.y + spread)}`,
    `${round(at.x + o)},${round(at.y)} ${round(at.x)},${round(at.y)}`,
  ]
}

/** Filled triangle at the referenced end, tip on the border and pointing into the card. */
export function oneMarker(at: Point, side: Side): string {
  const o = outward(side) * 8
  const half = 4
  return `${round(at.x + o)},${round(at.y - half)} ${round(at.x)},${round(at.y)} ${round(at.x + o)},${round(at.y + half)}`
}
