import { describe, expect, test } from 'bun:test'
import type { DiagramColumn, DiagramForeignKey, DiagramTable, SchemaDiagram } from './diagram'
import { buildDiagramEdges, chooseSides, manyMarker, oneMarker, type DiagramEdge } from './diagram-edges'
import { CARD_HEADER_HEIGHT, CARD_ROW_HEIGHT, anchorFor, layoutSchemaDiagram, type DiagramNode } from './diagram-layout'

const col = (name: string, over: Partial<DiagramColumn> = {}): DiagramColumn => ({
  name,
  type: 'integer',
  nullable: false,
  isPrimaryKey: false,
  isForeignKey: false,
  ...over,
})

const table = (name: string, columns: DiagramColumn[]): DiagramTable => ({
  name,
  kind: 'r',
  columns,
  estimatedRows: null,
})

const fk = (
  over: Partial<DiagramForeignKey> &
    Pick<DiagramForeignKey, 'name' | 'fromTable' | 'fromColumns' | 'toTable' | 'toColumns'>,
): DiagramForeignKey => ({ toSchema: 'public', ...over })

const diagramOf = (tables: DiagramTable[], foreignKeys: DiagramForeignKey[]): SchemaDiagram => ({
  schema: 'public',
  tables,
  foreignKeys,
  truncated: false,
})

const shop = (): SchemaDiagram =>
  diagramOf(
    [
      table('users', [
        col('id', { isPrimaryKey: true }),
        col('email', { type: 'text' }),
        col('referred_by', { nullable: true, isForeignKey: true }),
        col('created_at', { type: 'timestamptz' }),
      ]),
      table('orders', [
        col('id', { isPrimaryKey: true }),
        col('user_id', { isForeignKey: true }),
        col('billing_user_id', { isForeignKey: true }),
        col('total', { type: 'numeric' }),
      ]),
      table('order_items', [
        col('order_id', { isPrimaryKey: true, isForeignKey: true }),
        col('line_no', { isPrimaryKey: true, isForeignKey: true }),
        col('product_id', { isForeignKey: true }),
        col('qty'),
      ]),
      table('products', [col('id', { isPrimaryKey: true }), col('sku', { type: 'text' })]),
    ],
    [
      fk({
        name: 'orders_user_fk',
        fromTable: 'orders',
        fromColumns: ['user_id'],
        toTable: 'users',
        toColumns: ['id'],
      }),
      fk({
        name: 'orders_billing_fk',
        fromTable: 'orders',
        fromColumns: ['billing_user_id'],
        toTable: 'users',
        toColumns: ['id'],
      }),
      fk({
        name: 'users_referrer_fk',
        fromTable: 'users',
        fromColumns: ['referred_by'],
        toTable: 'users',
        toColumns: ['id'],
      }),
      fk({
        name: 'order_items_product_fk',
        fromTable: 'order_items',
        fromColumns: ['product_id'],
        toTable: 'products',
        toColumns: ['id'],
      }),
      fk({
        name: 'order_items_line_fk',
        fromTable: 'order_items',
        fromColumns: ['order_id', 'line_no'],
        toSchema: 'other',
        toTable: 'order_lines',
        toColumns: ['order_id', 'line_no'],
      }),
    ],
  )

const find = (edges: DiagramEdge[], pred: (e: DiagramEdge) => boolean): DiagramEdge => {
  const edge = edges.find(pred)
  if (!edge) throw new Error('edge not found')
  return edge
}

const nodeOf = (nodes: DiagramNode[], id: string): DiagramNode => {
  const node = nodes.find((n) => n.id === id)
  if (!node) throw new Error(`missing node ${id}`)
  return node
}

/** Row index of an anchor, from its y coordinate, inside the node (header excluded). */
const rowIndexOf = (node: DiagramNode, y: number): number =>
  (y - node.y - CARD_HEADER_HEIGHT - CARD_ROW_HEIGHT / 2) / CARD_ROW_HEIGHT

describe('diagram edges', () => {
  test('composite FK gives one edge per column pair, grouped by the FK name', () => {
    const diagram = shop()
    const nodes = layoutSchemaDiagram(diagram)
    const edges = buildDiagramEdges(nodes, diagram)
    const composite = edges.filter((e) => e.fk === 'order_items_line_fk')
    expect(composite).toHaveLength(2)
    expect(composite.map((e) => [e.fromTable, e.fromColumn, e.toTable, e.toColumn])).toEqual([
      ['public.order_items', 'order_id', 'other.order_lines', 'order_id'],
      ['public.order_items', 'line_no', 'other.order_lines', 'line_no'],
    ])
    expect(new Set(composite.map((e) => e.id)).size).toBe(2)
  })

  test('one edge per FK column pair in total, and parallel FKs stay distinct', () => {
    const diagram = shop()
    const edges = buildDiagramEdges(layoutSchemaDiagram(diagram), diagram)
    // 5 FKs, one of them composite with two columns
    expect(edges).toHaveLength(6)
    expect(new Set(edges.map((e) => e.id)).size).toBe(6)
    const parallel = edges.filter((e) => e.fromTable === 'public.orders' && e.toTable === 'public.users')
    expect(parallel.map((e) => e.fk).sort()).toEqual(['orders_billing_fk', 'orders_user_fk'])
  })

  test('endpoints are exactly the anchors of the FK row and the referenced row', () => {
    const diagram = shop()
    const nodes = layoutSchemaDiagram(diagram)
    const edges = buildDiagramEdges(nodes, diagram)
    for (const e of edges) {
      const source = nodeOf(nodes, e.fromTable)
      const target = nodeOf(nodes, e.toTable)
      expect(e.from).toEqual(anchorFor(source, e.fromColumn, e.fromSide)!)
      expect(e.to).toEqual(anchorFor(target, e.toColumn, e.toSide)!)
      // the middle of a row: the offset from the header is an odd multiple of half a row
      expect(Number.isInteger(rowIndexOf(source, e.from.y))).toBe(true)
      expect(Number.isInteger(rowIndexOf(target, e.to.y))).toBe(true)
    }
  })

  test('the path starts and ends at the endpoints it reports', () => {
    const diagram = shop()
    const edges = buildDiagramEdges(layoutSchemaDiagram(diagram), diagram)
    for (const e of edges) {
      const m = /^M (-?[\d.]+) (-?[\d.]+) C /.exec(e.path)
      expect(m).not.toBeNull()
      expect(Number(m![1])).toBeCloseTo(e.from.x, 1)
      expect(Number(m![2])).toBeCloseTo(e.from.y, 1)
      const end = /(-?[\d.]+) (-?[\d.]+)$/.exec(e.path)
      expect(Number(end![1])).toBeCloseTo(e.to.x, 1)
      expect(Number(end![2])).toBeCloseTo(e.to.y, 1)
    }
  })

  test('ghost targets are edge endpoints on the referenced column rows', () => {
    const diagram = shop()
    const nodes = layoutSchemaDiagram(diagram)
    const ghost = nodeOf(nodes, 'other.order_lines')
    const edges = buildDiagramEdges(nodes, diagram).filter((e) => e.toTable === 'other.order_lines')
    expect(edges.map((e) => e.to)).toEqual([
      anchorFor(ghost, 'order_id', edges[0]!.toSide)!,
      anchorFor(ghost, 'line_no', edges[1]!.toSide)!,
    ])
  })

  test('a referencing table to the right of the target leaves its left edge and enters the target right edge', () => {
    const diagram = shop()
    const nodes = layoutSchemaDiagram(diagram)
    const edges = buildDiagramEdges(nodes, diagram)
    const e = find(edges, (x) => x.fk === 'orders_user_fk')
    expect(nodeOf(nodes, 'public.orders').x).toBeGreaterThan(nodeOf(nodes, 'public.users').x)
    expect(e.fromSide).toBe('left')
    expect(e.toSide).toBe('right')
    expect(e.from.x).toBe(nodeOf(nodes, 'public.orders').x)
    expect(e.to.x).toBe(nodeOf(nodes, 'public.users').x + nodeOf(nodes, 'public.users').width)
  })

  test('side choice: fully right, fully left, overlap and self reference', () => {
    const a = { id: 'a', x: 0, width: 200 }
    expect(chooseSides(a, { id: 'b', x: 320, width: 200 })).toEqual({ fromSide: 'right', toSide: 'left', loop: false })
    expect(chooseSides(a, { id: 'b', x: -320, width: 200 })).toEqual({ fromSide: 'left', toSide: 'right', loop: false })
    expect(chooseSides(a, { id: 'b', x: 100, width: 200 })).toEqual({ fromSide: 'right', toSide: 'right', loop: true })
    // touching edges count as fully right
    expect(chooseSides(a, { id: 'b', x: 200, width: 200 })).toEqual({ fromSide: 'right', toSide: 'left', loop: false })
    expect(chooseSides(a, { id: 'a', x: 0, width: 200 })).toEqual({ fromSide: 'right', toSide: 'right', loop: true })
  })

  test('overlapping cards get right-side loops in the built edges', () => {
    const diagram = diagramOf(
      [
        table('left_t', [col('id', { isPrimaryKey: true })]),
        table('right_t', [col('left_id', { isForeignKey: true })]),
      ],
      [
        fk({
          name: 'overlap_fk',
          fromTable: 'right_t',
          fromColumns: ['left_id'],
          toTable: 'left_t',
          toColumns: ['id'],
        }),
      ],
    )
    const nodes = layoutSchemaDiagram(diagram).map((n) => (n.id === 'public.right_t' ? { ...n, x: n.x - 150 } : n))
    const [e] = buildDiagramEdges(nodes, diagram)
    expect(e!.fromSide).toBe('right')
    expect(e!.toSide).toBe('right')
    expect(e!.from.x).toBe(nodeOf(nodes, 'public.right_t').x + nodeOf(nodes, 'public.right_t').width)
  })

  test('self reference loops on the right side from the FK row to the referenced row', () => {
    const diagram = shop()
    const nodes = layoutSchemaDiagram(diagram)
    const e = find(buildDiagramEdges(nodes, diagram), (x) => x.fk === 'users_referrer_fk')
    const users = nodeOf(nodes, 'public.users')
    expect(e.fromTable).toBe(e.toTable)
    expect(e.fromSide).toBe('right')
    expect(e.toSide).toBe('right')
    expect(e.from).toEqual({
      x: users.x + users.width,
      y: users.y + CARD_HEADER_HEIGHT + 2 * CARD_ROW_HEIGHT + CARD_ROW_HEIGHT / 2,
    })
    expect(e.to).toEqual({
      x: users.x + users.width,
      y: users.y + CARD_HEADER_HEIGHT + CARD_ROW_HEIGHT / 2,
    })
    // the first control point is outside the card, so the curve really loops
    const control = /^M \S+ \S+ C (\S+) /.exec(e.path)!
    expect(Number(control[1])).toBeGreaterThan(users.x + users.width)
  })

  test('column rows move when the column mode changes, and edges re-anchor to them', () => {
    const diagram = shop()
    const all = layoutSchemaDiagram(diagram)
    const keys = layoutSchemaDiagram(diagram, { showAllColumns: false })
    const allEdge = find(buildDiagramEdges(all, diagram), (x) => x.fk === 'users_referrer_fk')
    const keysEdge = find(buildDiagramEdges(keys, diagram), (x) => x.fk === 'users_referrer_fk')

    const usesAll = nodeOf(all, 'public.users')
    const usesKeys = nodeOf(keys, 'public.users')
    expect(rowIndexOf(usesAll, allEdge.from.y)).toBe(2)
    expect(rowIndexOf(usesKeys, keysEdge.from.y)).toBe(1)
    expect(rowIndexOf(usesKeys, keysEdge.to.y)).toBe(0)
  })

  test('markers: crow foot at the FK end and a triangle tip on the referenced border', () => {
    const [crowFirst, crowCenter] = manyMarker({ x: 100, y: 50 }, 'right')
    // toes on the card border, meeting outside it (not an arrow into the card)
    expect(crowFirst).toBe('100,45 109,50 100,55')
    expect(crowCenter).toBe('109,50 100,50')
    expect(oneMarker({ x: 100, y: 50 }, 'left')).toBe('92,46 100,50 92,54')
  })
})
