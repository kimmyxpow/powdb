import { describe, expect, test } from 'bun:test'
import type { DiagramColumn, DiagramForeignKey, DiagramTable, SchemaDiagram } from './diagram'
import {
  CARD_HEADER_HEIGHT,
  CARD_MAX_WIDTH,
  CARD_MIN_WIDTH,
  CARD_ROW_HEIGHT,
  anchorFor,
  diagramBounds,
  layoutSchemaDiagram,
  placeNodes,
  type DiagramNode,
} from './diagram-layout'

const col = (name: string, over: Partial<DiagramColumn> = {}): DiagramColumn => ({
  name,
  type: 'integer',
  nullable: false,
  isPrimaryKey: false,
  isForeignKey: false,
  ...over,
})

const table = (name: string, columns: DiagramColumn[], estimatedRows: number | null = null): DiagramTable => ({
  name,
  kind: 'r',
  columns,
  estimatedRows,
})

const fk = (
  over: Partial<DiagramForeignKey> &
    Pick<DiagramForeignKey, 'name' | 'fromTable' | 'fromColumns' | 'toTable' | 'toColumns'>,
): DiagramForeignKey => ({
  toSchema: 'public',
  ...over,
})

const diagramOf = (tables: DiagramTable[], foreignKeys: DiagramForeignKey[]): SchemaDiagram => ({
  schema: 'public',
  tables,
  foreignKeys,
  truncated: false,
})

// Connected: users, orders, order_items, products. Isolated: audit_log.
// Ghost: other.order_lines (composite FK target in another schema).
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
      table('audit_log', [col('id', { isPrimaryKey: true }), col('payload', { type: 'jsonb' })]),
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

// 3 connected tables (orders -> users, orders -> products, users self-reference) and 7 isolated tables.
const crowded = (): SchemaDiagram =>
  diagramOf(
    [
      table('users', [col('id', { isPrimaryKey: true }), col('referred_by', { isForeignKey: true })]),
      table('orders', [
        col('id', { isPrimaryKey: true }),
        col('user_id', { isForeignKey: true }),
        col('product_id', { isForeignKey: true }),
      ]),
      table('products', [col('id', { isPrimaryKey: true })]),
      ...['archive_a', 'archive_b', 'archive_c', 'archive_d', 'archive_e', 'archive_f', 'archive_g'].map((name) =>
        table(
          name,
          [col('id', { isPrimaryKey: true }), col('note', { type: 'text' }), col('extra', { type: 'text' })],
          12,
        ),
      ),
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
        name: 'orders_product_fk',
        fromTable: 'orders',
        fromColumns: ['product_id'],
        toTable: 'products',
        toColumns: ['id'],
      }),
      fk({
        name: 'users_referrer_fk',
        fromTable: 'users',
        fromColumns: ['referred_by'],
        toTable: 'users',
        toColumns: ['id'],
      }),
    ],
  )

// A cycle a -> b -> c -> a (each table references the next) plus a feeder d -> a.
const cycle = (): SchemaDiagram =>
  diagramOf(
    ['a', 'b', 'c', 'd'].map((name) =>
      table(name, [
        col('id', { isPrimaryKey: true }),
        col('ref', { isForeignKey: true }),
        col('label', { type: 'text' }),
      ]),
    ),
    [
      fk({ name: 'a_b', fromTable: 'a', fromColumns: ['ref'], toTable: 'b', toColumns: ['id'] }),
      fk({ name: 'b_c', fromTable: 'b', fromColumns: ['ref'], toTable: 'c', toColumns: ['id'] }),
      fk({ name: 'c_a', fromTable: 'c', fromColumns: ['ref'], toTable: 'a', toColumns: ['id'] }),
      fk({ name: 'd_a', fromTable: 'd', fromColumns: ['ref'], toTable: 'a', toColumns: ['id'] }),
    ],
  )

// Keys mode must keep a referenced column that is neither PK nor FK (products.sku).
const uniqueTarget = (): SchemaDiagram =>
  diagramOf(
    [
      table('products', [
        col('id', { isPrimaryKey: true }),
        col('sku', { type: 'text' }),
        col('name', { type: 'text' }),
      ]),
      table('order_items', [
        col('id', { isPrimaryKey: true }),
        col('product_sku', { type: 'text', isForeignKey: true }),
      ]),
    ],
    [
      fk({
        name: 'items_sku_fk',
        fromTable: 'order_items',
        fromColumns: ['product_sku'],
        toTable: 'products',
        toColumns: ['sku'],
      }),
    ],
  )

const rectOf = (n: { x: number; y: number; width: number; height: number }) => ({
  x: n.x,
  y: n.y,
  w: n.width,
  h: n.height,
})

const overlaps = (a: ReturnType<typeof rectOf>, b: ReturnType<typeof rectOf>) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

const byId = (nodes: DiagramNode[], id: string): DiagramNode => {
  const node = nodes.find((n) => n.id === id)
  if (!node) throw new Error(`missing node ${id}`)
  return node
}

const expectNoOverlaps = (nodes: DiagramNode[]) => {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      expect(overlaps(rectOf(nodes[i]!), rectOf(nodes[j]!))).toBe(false)
    }
  }
}

describe('diagram layout', () => {
  test('one node per table plus one ghost per distinct external FK target', () => {
    const nodes = layoutSchemaDiagram(shop())
    expect(nodes.map((n) => n.id)).toEqual([
      'other.order_lines',
      'public.audit_log',
      'public.order_items',
      'public.orders',
      'public.products',
      'public.users',
    ])
    expect(byId(nodes, 'other.order_lines').kind).toBe('ghost')
    expect(byId(nodes, 'public.users').kind).toBe('r')
  })

  test('ghost nodes show only the referenced columns, in FK order, without types', () => {
    const ghost = byId(layoutSchemaDiagram(shop()), 'other.order_lines')
    expect(ghost.columns.map((c) => c.name)).toEqual(['order_id', 'line_no'])
    expect(ghost.columns.every((c) => c.type === '')).toBe(true)
    expect(ghost.hiddenColumns).toBe(0)
    expect(ghost.height).toBe(CARD_HEADER_HEIGHT + 2 * CARD_ROW_HEIGHT + 6)
  })

  test('referenced tables sit left of the tables that reference them', () => {
    const nodes = layoutSchemaDiagram(shop())
    const x = (id: string) => byId(nodes, id).x
    expect(x('public.users')).toBeLessThan(x('public.orders'))
    expect(x('public.products')).toBeLessThan(x('public.order_items'))
    expect(x('other.order_lines')).toBeLessThan(x('public.order_items'))
    // the rank gap is at least the 120 units of the spec
    const users = byId(nodes, 'public.users')
    const orders = byId(nodes, 'public.orders')
    expect(orders.x - (users.x + users.width)).toBeGreaterThanOrEqual(120)
  })

  test('cycles do not crash and give finite positions without overlaps', () => {
    const nodes = layoutSchemaDiagram(cycle())
    expect(nodes).toHaveLength(4)
    for (const n of nodes) {
      expect(Number.isFinite(n.x)).toBe(true)
      expect(Number.isFinite(n.y)).toBe(true)
    }
    expectNoOverlaps(nodes)
  })

  test('self references do not change ranks', () => {
    const nodes = layoutSchemaDiagram(crowded())
    // users is referenced by orders and by itself; the self reference must not push it further right
    expect(byId(nodes, 'public.users').x).toBeLessThan(byId(nodes, 'public.orders').x)
    expect(byId(nodes, 'public.products').x).toBeLessThan(byId(nodes, 'public.orders').x)
  })

  test('no overlapping cards, including a large schema', () => {
    expectNoOverlaps(layoutSchemaDiagram(shop()))
    expectNoOverlaps(layoutSchemaDiagram(crowded()))

    const many: DiagramTable[] = []
    const fks: DiagramForeignKey[] = []
    for (let i = 0; i < 300; i++) {
      many.push(
        table(`t${String(i).padStart(3, '0')}`, [
          col('id', { isPrimaryKey: true }),
          col('parent', { isForeignKey: true }),
        ]),
      )
      if (i >= 5 && i % 3 !== 0) {
        fks.push(
          fk({
            name: `fk_${i}`,
            fromTable: `t${String(i).padStart(3, '0')}`,
            fromColumns: ['parent'],
            toTable: `t${String(i - 5).padStart(3, '0')}`,
            toColumns: ['id'],
          }),
        )
      }
    }
    const nodes = layoutSchemaDiagram(diagramOf(many, fks))
    expect(nodes).toHaveLength(300)
    expectNoOverlaps(nodes)
  })

  test('isolated tables form a grid below the connected block, sorted by name', () => {
    const nodes = layoutSchemaDiagram(crowded())
    const connected = ['public.users', 'public.orders', 'public.products']
    const connectedBottom = Math.max(...connected.map((id) => byId(nodes, id).y + byId(nodes, id).height))
    const isolated = nodes.filter((n) => !connected.includes(n.id))
    expect(isolated).toHaveLength(7)
    for (const n of isolated) {
      expect(n.y).toBeGreaterThanOrEqual(connectedBottom + 80)
    }
    // sqrt(7) rounds up to 3 per row: the first row holds archive_a..c, sorted by name
    const firstRow = isolated.filter((n) => n.y === isolated[0]!.y)
    expect(firstRow.map((n) => n.name)).toEqual(['archive_a', 'archive_b', 'archive_c'])
    expect(firstRow[1]!.x).toBeGreaterThan(firstRow[0]!.x)
  })

  test('the same diagram gives the same positions every time', () => {
    expect(layoutSchemaDiagram(shop())).toEqual(layoutSchemaDiagram(shop()))
    expect(layoutSchemaDiagram(cycle())).toEqual(layoutSchemaDiagram(cycle()))
    expect(layoutSchemaDiagram(crowded(), { showAllColumns: false })).toEqual(
      layoutSchemaDiagram(crowded(), { showAllColumns: false }),
    )
  })

  test('keys mode keeps PK, FK and referenced columns, and counts the hidden ones', () => {
    const all = byId(layoutSchemaDiagram(shop()), 'public.users')
    expect(all.columns).toHaveLength(4)
    expect(all.hiddenColumns).toBe(0)

    const keys = byId(layoutSchemaDiagram(shop(), { showAllColumns: false }), 'public.users')
    expect(keys.columns.map((c) => c.name)).toEqual(['id', 'referred_by'])
    expect(keys.hiddenColumns).toBe(2)
    expect(keys.height).toBe(CARD_HEADER_HEIGHT + 2 * CARD_ROW_HEIGHT + CARD_ROW_HEIGHT + 6)

    const audit = byId(layoutSchemaDiagram(shop(), { showAllColumns: false }), 'public.audit_log')
    expect(audit.columns.map((c) => c.name)).toEqual(['id'])
    expect(audit.hiddenColumns).toBe(1)
  })

  test('keys mode keeps a referenced column that is neither PK nor FK', () => {
    const keys = layoutSchemaDiagram(uniqueTarget(), { showAllColumns: false })
    expect(byId(keys, 'public.products').columns.map((c) => c.name)).toEqual(['id', 'sku'])
    expect(byId(keys, 'public.products').hiddenColumns).toBe(1)
  })

  test('card height is header plus rows (plus footer when columns are hidden) plus padding', () => {
    const { height } = byId(layoutSchemaDiagram(shop()), 'public.users')
    expect(height).toBe(CARD_HEADER_HEIGHT + 4 * CARD_ROW_HEIGHT + 6)
  })

  test('card width is clamped between the minimum and the maximum', () => {
    const nodes = layoutSchemaDiagram(shop())
    for (const n of nodes) {
      expect(n.width).toBeGreaterThanOrEqual(CARD_MIN_WIDTH)
      expect(n.width).toBeLessThanOrEqual(CARD_MAX_WIDTH)
    }
    const long = diagramOf([table('x'.repeat(120), [col('y'.repeat(120), { type: 'character varying(255)' })])], [])
    expect(byId(layoutSchemaDiagram(long), 'public.' + 'x'.repeat(120)).width).toBe(CARD_MAX_WIDTH)
  })

  test('anchorFor gives the middle of the visible row on the card border', () => {
    const users = byId(layoutSchemaDiagram(shop()), 'public.users')
    const index = users.columns.findIndex((c) => c.name === 'referred_by')
    const expectedY = users.y + CARD_HEADER_HEIGHT + index * CARD_ROW_HEIGHT + CARD_ROW_HEIGHT / 2
    expect(anchorFor(users, 'referred_by', 'right')).toEqual({ x: users.x + users.width, y: expectedY })
    expect(anchorFor(users, 'referred_by', 'left')).toEqual({ x: users.x, y: expectedY })
    expect(anchorFor(users, 'no_such_column', 'right')).toBeNull()
  })

  test('diagramBounds covers all cards and is null for none', () => {
    const nodes = layoutSchemaDiagram(shop())
    const b = diagramBounds(nodes)!
    for (const n of nodes) {
      expect(n.x).toBeGreaterThanOrEqual(b.x)
      expect(n.y).toBeGreaterThanOrEqual(b.y)
      expect(n.x + n.width).toBeLessThanOrEqual(b.x + b.width)
      expect(n.y + n.height).toBeLessThanOrEqual(b.y + b.height)
    }
    expect(diagramBounds([])).toBeNull()
  })

  test('empty diagram returns no nodes', () => {
    expect(layoutSchemaDiagram(diagramOf([], []))).toEqual([])
  })

  test('placeNodes keeps saved positions and stacks new tables right of the saved block', () => {
    const auto = layoutSchemaDiagram(shop())
    expect(placeNodes(auto, null)).toBe(auto)

    const saved: Record<string, { x: number; y: number }> = {}
    for (const n of auto) saved[n.id] = { x: n.x + 10, y: n.y + 10 }
    saved['public.users'] = { x: 5000, y: 0 }
    delete saved['public.audit_log']

    const placed = placeNodes(auto, saved)
    expect(byId(placed, 'public.users').x).toBe(5000)
    expect(byId(placed, 'public.orders').x).toBe(byId(auto, 'public.orders').x + 10)

    const fresh = byId(placed, 'public.audit_log')
    const rightEdge = Math.max(...auto.filter((n) => n.id !== 'public.audit_log').map((n) => saved[n.id]!.x + n.width))
    expect(fresh.x).toBeGreaterThanOrEqual(rightEdge + 120)
    expectNoOverlaps(placed)
  })

  test('placeNodes with saved positions for none of the current tables uses the auto layout', () => {
    const auto = layoutSchemaDiagram(shop())
    expect(placeNodes(auto, { 'public.gone': { x: 1, y: 1 } })).toBe(auto)
  })
})
