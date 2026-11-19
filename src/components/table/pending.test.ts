import { describe, expect, test } from 'bun:test'
import type { GridValue } from '@/components/grid/types'
import type { Cell, RowChanges, RowKey } from '@/lib/types'
import { buildChanges, changeRowIds, emptyPending, pendingStats, previewSql, savedRowIndex } from './pending'
import type { PendingChanges } from './pending'

const FIELDS = ['id', 'name', 'active', 'note']

/** A row id to its key; a row id missing here has no key, so the grid cannot address it. */
function keyed(entries: [string, RowKey][]) {
  const map = new Map(entries)
  return (rowId: string): RowKey | null => map.get(rowId) ?? null
}

function pending(parts: Partial<PendingChanges>): PendingChanges {
  return { ...emptyPending(), ...parts }
}

function changes(parts: Partial<RowChanges> = {}): RowChanges {
  return { schema: 'public', table: 'orders', updates: [], inserts: [], deletes: [], ...parts }
}

describe('savedRowIndex', () => {
  const rows = [
    [1, 'a'],
    [7, 'b'],
    [9, 'c'],
  ]

  test('finds the saved row by its primary key', () => {
    expect(savedRowIndex(new Map<number, unknown>([[0, 7]]), [0], rows)).toBe(1)
  })

  test('a key typed as text matches the number the database returns', () => {
    expect(savedRowIndex(new Map<number, unknown>([[0, '9']]), [0], rows)).toBe(2)
  })

  test('-1 when the row is not on this page', () => {
    expect(savedRowIndex(new Map<number, unknown>([[0, 8]]), [0], rows)).toBe(-1)
  })

  test('-1 when the key was left to the database (no value staged)', () => {
    expect(savedRowIndex(new Map<number, unknown>([[1, 'x']]), [0], rows)).toBe(-1)
  })

  test('-1 for a key that is not a plain value (default marker, JSON)', () => {
    expect(savedRowIndex(new Map<number, unknown>([[0, { default: true }]]), [0], rows)).toBe(-1)
  })

  test('-1 with no primary key, or no staged values', () => {
    expect(savedRowIndex(new Map<number, unknown>([[0, 7]]), [], rows)).toBe(-1)
    expect(savedRowIndex(undefined, [0], rows)).toBe(-1)
  })

  test('composite keys must match on every column', () => {
    const grid = [
      [1, 'a', 'x'],
      [1, 'b', 'y'],
    ]
    expect(
      savedRowIndex(
        new Map<number, unknown>([
          [0, 1],
          [1, 'b'],
        ]),
        [0, 1],
        grid,
      ),
    ).toBe(1)
    expect(
      savedRowIndex(
        new Map<number, unknown>([
          [0, 1],
          [1, 'z'],
        ]),
        [0, 1],
        grid,
      ),
    ).toBe(-1)
  })
})

describe('pendingStats', () => {
  test('empty pending counts nothing', () => {
    expect(pendingStats(emptyPending())).toEqual({ edited: 0, inserted: 0, deleted: 0, total: 0 })
  })

  test('edited, inserted and deleted rows are counted separately', () => {
    const p = pending({
      edits: new Map<string, Map<number, Cell>>([
        ['r1', new Map<number, Cell>([[1, 'x']])],
        ['r2', new Map<number, Cell>([[2, true]])],
      ]),
      inserts: [{ id: 'new:1', values: new Map<number, GridValue>() }],
      deletes: new Set(['r3']),
    })
    expect(pendingStats(p)).toEqual({ edited: 2, inserted: 1, deleted: 1, total: 4 })
  })

  test('an edit on a row marked deleted is not counted as an edit', () => {
    const p = pending({
      edits: new Map<string, Map<number, Cell>>([['r1', new Map<number, Cell>([[1, 'x']])]]),
      deletes: new Set(['r1']),
    })
    expect(pendingStats(p)).toEqual({ edited: 0, inserted: 0, deleted: 1, total: 1 })
  })

  const keyFor = keyed([
    ['r1', { id: '1' }],
    ['r2', { id: '2' }],
  ])

  test('with keyFor, a delete of a row without a key is not counted', () => {
    const p = pending({ deletes: new Set(['r1', 'r9']) })
    expect(pendingStats(p, keyFor)).toEqual({ edited: 0, inserted: 0, deleted: 1, total: 1 })
  })

  test('with keyFor, an edit of a row without a key is not counted', () => {
    const p = pending({ edits: new Map<string, Map<number, Cell>>([['r9', new Map<number, Cell>([[1, 'x']])]]) })
    expect(pendingStats(p, keyFor)).toEqual({ edited: 0, inserted: 0, deleted: 0, total: 0 })
  })

  test('with keyFor, an edit with no cells is not counted', () => {
    const p = pending({ edits: new Map<string, Map<number, Cell>>([['r1', new Map<number, Cell>()]]) })
    expect(pendingStats(p, keyFor)).toEqual({ edited: 0, inserted: 0, deleted: 0, total: 0 })
  })

  test('with keyFor, inserts are always counted', () => {
    const p = pending({ inserts: [{ id: 'new:1', values: new Map<number, GridValue>() }] })
    expect(pendingStats(p, keyFor)).toEqual({ edited: 0, inserted: 1, deleted: 0, total: 1 })
  })

  test('with keyFor, the counts equal the statements buildChanges produces', () => {
    const p = pending({
      edits: new Map<string, Map<number, Cell>>([
        ['r1', new Map<number, Cell>([[1, 'Ann']])],
        ['r2', new Map<number, Cell>()],
        ['r2b', new Map<number, Cell>([[1, 'x']])],
        ['r3', new Map<number, Cell>([[1, 'x']])],
        ['r4', new Map<number, Cell>([[1, 'y']])],
      ]),
      inserts: [{ id: 'new:1', values: new Map<number, GridValue>([[1, 'Bo']]) }],
      deletes: new Set(['r2', 'r5', 'r4']),
    })
    const built = buildChanges('public', 'orders', p, FIELDS, keyFor)
    const statements = built.updates.length + built.inserts.length + built.deletes.length
    const stats = pendingStats(p, keyFor)
    expect(stats).toEqual({ edited: 1, inserted: 1, deleted: 1, total: 3 })
    expect(stats.total).toBe(statements)
    expect(changeRowIds(p, keyFor)).toEqual({ update: ['r1'], insert: ['new:1'], delete: ['r2'] })
  })
})

describe('buildChanges', () => {
  const keyFor = keyed([
    ['r1', { id: '1' }],
    ['r2', { id: '2' }],
    ['r3', { id: '3' }],
  ])

  test('an update, an insert and a delete make one change set', () => {
    const p = pending({
      edits: new Map<string, Map<number, Cell>>([
        [
          'r1',
          new Map<number, Cell>([
            [1, 'Ann'],
            [3, null],
          ]),
        ],
      ]),
      inserts: [
        {
          id: 'new:1',
          values: new Map<number, GridValue>([
            [0, '9'],
            [1, 'Bo'],
          ]),
        },
      ],
      deletes: new Set(['r2']),
    })
    expect(buildChanges('public', 'orders', p, FIELDS, keyFor)).toEqual({
      schema: 'public',
      table: 'orders',
      updates: [{ key: { id: '1' }, values: { name: 'Ann', note: null } }],
      inserts: [{ values: { id: '9', name: 'Bo' } }],
      deletes: [{ key: { id: '2' } }],
    })
  })

  test('booleans and DEFAULT markers reach the change unchanged', () => {
    const p = pending({
      edits: new Map<string, Map<number, Cell>>([['r1', new Map<number, Cell>([[2, false]])]]),
      inserts: [
        {
          id: 'new:1',
          values: new Map<number, GridValue>([
            [0, { default: true }],
            [2, true],
            [3, null],
          ]),
        },
      ],
    })
    expect(buildChanges('public', 'orders', p, FIELDS, keyFor)).toEqual(
      changes({
        updates: [{ key: { id: '1' }, values: { active: false } }],
        inserts: [{ values: { id: { default: true }, active: true, note: null } }],
      }),
    )
  })

  test('an edit on a row marked deleted is not emitted, and its delete is', () => {
    const p = pending({
      edits: new Map<string, Map<number, Cell>>([['r1', new Map<number, Cell>([[1, 'x']])]]),
      deletes: new Set(['r1']),
    })
    expect(buildChanges('public', 'orders', p, FIELDS, keyFor)).toEqual(changes({ deletes: [{ key: { id: '1' } }] }))
  })

  test('a row with no key is neither updated nor deleted, but its insert still goes out', () => {
    const p = pending({
      edits: new Map<string, Map<number, Cell>>([['r9', new Map<number, Cell>([[1, 'x']])]]),
      inserts: [{ id: 'new:1', values: new Map<number, GridValue>([[1, 'Bo']]) }],
      deletes: new Set(['r8']),
    })
    expect(buildChanges('public', 'orders', p, FIELDS, keyFor)).toEqual(
      changes({ inserts: [{ values: { name: 'Bo' } }] }),
    )
  })

  test('a ctid-keyed table addresses its rows by ctid', () => {
    const ctidKey = keyed([['r1', { ctid: '(0,1)' }]])
    const p = pending({ edits: new Map<string, Map<number, Cell>>([['r1', new Map<number, Cell>([[1, 'Ann']])]]) })
    expect(buildChanges('public', 'orders', p, FIELDS, ctidKey)).toEqual(
      changes({ updates: [{ key: { ctid: '(0,1)' }, values: { name: 'Ann' } }] }),
    )
  })

  test('empty pending gives an empty change set', () => {
    expect(buildChanges('public', 'orders', emptyPending(), FIELDS, keyFor)).toEqual(changes())
  })
})

describe('previewSql', () => {
  test('empty changes give BEGIN and COMMIT only', () => {
    expect(previewSql(changes())).toBe('BEGIN;\n\n\nCOMMIT;')
  })

  test('deletes, then updates, then inserts, as exact SQL text', () => {
    const sql = previewSql(
      changes({
        updates: [{ key: { id: '1' }, values: { name: 'Ann', note: null } }],
        inserts: [{ values: { id: '9', name: 'Bo', active: true } }],
        deletes: [{ key: { id: '2' } }],
      }),
    )
    expect(sql).toBe(
      [
        'BEGIN;',
        '',
        "DELETE FROM orders WHERE id = '2';",
        "UPDATE orders SET name = 'Ann', note = NULL WHERE id = '1';",
        "INSERT INTO orders (id, name, active) VALUES ('9', 'Bo', TRUE);",
        '',
        'COMMIT;',
      ].join('\n'),
    )
  })

  test('a NULL key column is IS NULL, and a composite key is joined with AND', () => {
    const sql = previewSql(changes({ table: 'pairs', deletes: [{ key: { a: '1', b: null } }] }))
    expect(sql).toBe("BEGIN;\n\nDELETE FROM pairs WHERE a = '1' AND b IS NULL;\n\nCOMMIT;")
  })

  test('a ctid row is addressed as a tid literal', () => {
    const sql = previewSql(changes({ table: 't', updates: [{ key: { ctid: '(0,1)' }, values: { name: 'Ann' } }] }))
    expect(sql).toBe("BEGIN;\n\nUPDATE t SET name = 'Ann' WHERE ctid = '(0,1)'::tid;\n\nCOMMIT;")
  })

  test('an insert of only DEFAULT values is INSERT ... DEFAULT VALUES', () => {
    const sql = previewSql(changes({ inserts: [{ values: { id: { default: true }, name: { default: true } } }] }))
    expect(sql).toBe('BEGIN;\n\nINSERT INTO orders DEFAULT VALUES;\n\nCOMMIT;')
  })

  test('DEFAULT values are left out of an insert that has other values', () => {
    const sql = previewSql(changes({ inserts: [{ values: { id: { default: true }, name: 'Bo', note: null } }] }))
    expect(sql).toBe("BEGIN;\n\nINSERT INTO orders (name, note) VALUES ('Bo', NULL);\n\nCOMMIT;")
  })

  test('a schema other than public is qualified', () => {
    const sql = previewSql(changes({ schema: 'sales', deletes: [{ key: { id: '1' } }] }))
    expect(sql).toBe("BEGIN;\n\nDELETE FROM sales.orders WHERE id = '1';\n\nCOMMIT;")
  })

  test.each<[string, string]>([
    ['name', 'name'],
    ['user_id', 'user_id'],
    ['Full Name', '"Full Name"'],
    ['order', '"order"'],
    ['select', '"select"'],
    ['1st', '"1st"'],
    ['a"b', '"a""b"'],
  ])('column %p is written as %s', (column, written) => {
    const sql = previewSql(changes({ updates: [{ key: { id: '1' }, values: { [column]: 'v' } }] }))
    expect(sql).toBe(`BEGIN;\n\nUPDATE orders SET ${written} = 'v' WHERE id = '1';\n\nCOMMIT;`)
  })

  test('mixed-case table, schema and key column names are quoted', () => {
    expect(previewSql(changes({ table: 'Orders', deletes: [{ key: { 'Order Id': '7' } }] }))).toBe(
      'BEGIN;\n\nDELETE FROM "Orders" WHERE "Order Id" = \'7\';\n\nCOMMIT;',
    )
    expect(previewSql(changes({ schema: 'Sales', deletes: [{ key: { id: '7' } }] }))).toBe(
      'BEGIN;\n\nDELETE FROM "Sales".orders WHERE id = \'7\';\n\nCOMMIT;',
    )
  })

  test.each<[Cell, string]>([
    ["O'Brien", "'O''Brien'"],
    ['C:\\temp', "E'C:\\\\temp'"],
    ["a\\'b", "E'a\\\\''b'"],
    ["it's \\ ok", "E'it''s \\\\ ok'"],
    ['', "''"],
    ['42', "'42'"],
    [true, 'TRUE'],
    [false, 'FALSE'],
    [null, 'NULL'],
  ])('the value %p is written as the literal %s', (value, literal) => {
    const sql = previewSql(changes({ updates: [{ key: { id: '1' }, values: { name: value } }] }))
    expect(sql).toBe(`BEGIN;\n\nUPDATE orders SET name = ${literal} WHERE id = '1';\n\nCOMMIT;`)
  })
})

describe('changeRowIds', () => {
  test('ids come in change-list order, skipping deleted and unkeyed rows', () => {
    const keyFor = keyed([
      ['r1', { id: '1' }],
      ['r2', { id: '2' }],
      ['r3', { id: '3' }],
    ])
    const p = pending({
      edits: new Map<string, Map<number, Cell>>([
        ['r1', new Map<number, Cell>([[1, 'x']])],
        ['r2', new Map<number, Cell>([[1, 'y']])],
        ['r3', new Map<number, Cell>([[1, 'z']])],
        ['r5', new Map<number, Cell>([[1, 'w']])],
      ]),
      inserts: [
        { id: 'new:1', values: new Map<number, GridValue>() },
        { id: 'new:2', values: new Map<number, GridValue>() },
      ],
      deletes: new Set(['r3', 'r2', 'r4']),
    })
    expect(changeRowIds(p, keyFor)).toEqual({ update: ['r1'], insert: ['new:1', 'new:2'], delete: ['r3', 'r2'] })
  })

  test('the ids point at the same rows as the change lists', () => {
    const keyFor = keyed([
      ['r1', { id: '1' }],
      ['r2', { id: '2' }],
      ['r3', { id: '3' }],
    ])
    const p = pending({
      edits: new Map<string, Map<number, Cell>>([
        ['r1', new Map<number, Cell>([[1, 'x']])],
        ['r3', new Map<number, Cell>([[1, 'z']])],
      ]),
      deletes: new Set(['r2']),
    })
    const ids = changeRowIds(p, keyFor)
    const built = buildChanges('public', 'orders', p, FIELDS, keyFor)
    expect(ids.update.map((id) => keyFor(id))).toEqual(built.updates.map((u) => u.key))
    expect(ids.delete.map((id) => keyFor(id))).toEqual(built.deletes.map((d) => d.key))
  })

  test('empty pending has no ids', () => {
    expect(changeRowIds(emptyPending(), keyed([]))).toEqual({ update: [], insert: [], delete: [] })
  })
})
