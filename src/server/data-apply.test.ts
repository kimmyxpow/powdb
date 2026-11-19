import { describe, expect, test } from 'bun:test'
import type { RowChanges, RowKey } from '@/lib/types'
import { assertOne, changeStatements, InvalidViewError, type RelationShape } from './data.server'

const ORDERS = '"public"."orders"'
const orders: RelationShape = {
  kind: 'r',
  columns: ['id', 'name', 'active', 'note'],
  primaryKey: ['id'],
  estimatedRows: null,
}

function changes(parts: Partial<RowChanges> = {}): RowChanges {
  return { schema: 'public', table: 'orders', updates: [], inserts: [], deletes: [], ...parts }
}

describe('changeStatements: primary key table', () => {
  test('update: SET values first, then the key, numbered in order', () => {
    const out = changeStatements(
      orders,
      changes({ updates: [{ key: { id: '1' }, values: { name: 'Ann', note: null } }] }),
      ORDERS,
    )
    expect(out).toEqual([
      {
        kind: 'update',
        index: 0,
        text: 'UPDATE "public"."orders" SET "name" = $1, "note" = $2 WHERE "id" = $3',
        values: ['Ann', null, '1'],
      },
    ])
  })

  test('delete: key condition only', () => {
    const out = changeStatements(orders, changes({ deletes: [{ key: { id: '2' } }] }), ORDERS)
    expect(out).toEqual([
      { kind: 'delete', index: 0, text: 'DELETE FROM "public"."orders" WHERE "id" = $1', values: ['2'] },
    ])
  })

  test('insert: columns and values in the order the change lists them', () => {
    const out = changeStatements(
      orders,
      changes({ inserts: [{ values: { id: '9', name: 'Bo', active: true } }] }),
      ORDERS,
    )
    expect(out).toEqual([
      {
        kind: 'insert',
        index: 0,
        text: 'INSERT INTO "public"."orders" ("id", "name", "active") VALUES ($1, $2, $3)',
        values: ['9', 'Bo', true],
      },
    ])
  })

  test('a NULL key value is IS NULL with no parameter', () => {
    const out = changeStatements(orders, changes({ deletes: [{ key: { id: null } }] }), ORDERS)
    expect(out).toEqual([
      { kind: 'delete', index: 0, text: 'DELETE FROM "public"."orders" WHERE "id" IS NULL', values: [] },
    ])
  })

  test('a composite key follows the primary key column order, not the order of the key object', () => {
    const pairs: RelationShape = {
      kind: 'r',
      columns: ['a', 'b', 'c'],
      primaryKey: ['a', 'b'],
      estimatedRows: null,
    }
    const out = changeStatements(
      pairs,
      changes({ table: 'pairs', updates: [{ key: { b: 'y', a: '1' }, values: { c: 'z' } }] }),
      '"public"."pairs"',
    )
    expect(out).toEqual([
      {
        kind: 'update',
        index: 0,
        text: 'UPDATE "public"."pairs" SET "c" = $1 WHERE "a" = $2 AND "b" = $3',
        values: ['z', '1', 'y'],
      },
    ])
  })

  test('a composite key with a NULL column keeps IS NULL out of the parameters', () => {
    const pairs: RelationShape = {
      kind: 'r',
      columns: ['a', 'b'],
      primaryKey: ['a', 'b'],
      estimatedRows: null,
    }
    const out = changeStatements(
      pairs,
      changes({ table: 'pairs', deletes: [{ key: { a: '1', b: null } }] }),
      '"public"."pairs"',
    )
    expect(out).toEqual([
      { kind: 'delete', index: 0, text: 'DELETE FROM "public"."pairs" WHERE "a" = $1 AND "b" IS NULL', values: ['1'] },
    ])
  })
})

describe('changeStatements: ctid table', () => {
  const plain: RelationShape = { kind: 'r', columns: ['name'], primaryKey: [], estimatedRows: null }
  const T = '"public"."t"'

  test('update and delete address the row by ctid', () => {
    const out = changeStatements(
      plain,
      changes({
        table: 't',
        updates: [{ key: { ctid: '(0,1)' }, values: { name: 'Ann' } }],
        deletes: [{ key: { ctid: '(0,2)' } }],
      }),
      T,
    )
    expect(out).toEqual([
      { kind: 'delete', index: 0, text: 'DELETE FROM "public"."t" WHERE ctid = $1::tid', values: ['(0,2)'] },
      {
        kind: 'update',
        index: 0,
        text: 'UPDATE "public"."t" SET "name" = $1 WHERE ctid = $2::tid',
        values: ['Ann', '(0,1)'],
      },
    ])
  })
})

describe('changeStatements: inserts with column defaults', () => {
  test('every value DEFAULT gives INSERT ... DEFAULT VALUES', () => {
    const out = changeStatements(
      orders,
      changes({ inserts: [{ values: { id: { default: true }, name: { default: true } } }] }),
      ORDERS,
    )
    expect(out).toEqual([
      { kind: 'insert', index: 0, text: 'INSERT INTO "public"."orders" DEFAULT VALUES', values: [] },
    ])
  })

  test('an insert with no values at all is also DEFAULT VALUES', () => {
    const out = changeStatements(orders, changes({ inserts: [{ values: {} }] }), ORDERS)
    expect(out).toEqual([
      { kind: 'insert', index: 0, text: 'INSERT INTO "public"."orders" DEFAULT VALUES', values: [] },
    ])
  })

  test('DEFAULT values are left out of the column list, the others keep their order', () => {
    const out = changeStatements(
      orders,
      changes({ inserts: [{ values: { id: { default: true }, name: 'Bo', active: { default: true }, note: null } }] }),
      ORDERS,
    )
    expect(out).toEqual([
      {
        kind: 'insert',
        index: 0,
        text: 'INSERT INTO "public"."orders" ("name", "note") VALUES ($1, $2)',
        values: ['Bo', null],
      },
    ])
  })
})

describe('changeStatements: order and indexes', () => {
  test('deletes run first, then updates, then inserts; a skipped update keeps its index', () => {
    const out = changeStatements(
      orders,
      changes({
        deletes: [{ key: { id: '1' } }, { key: { id: '2' } }],
        updates: [
          { key: { id: '3' }, values: {} },
          { key: { id: '4' }, values: { name: 'Cy' } },
        ],
        inserts: [{ values: { name: 'Di' } }],
      }),
      ORDERS,
    )
    expect(out.map(({ kind, index }) => ({ kind, index }))).toEqual([
      { kind: 'delete', index: 0 },
      { kind: 'delete', index: 1 },
      { kind: 'update', index: 1 },
      { kind: 'insert', index: 0 },
    ])
    expect(out[2]).toEqual({
      kind: 'update',
      index: 1,
      text: 'UPDATE "public"."orders" SET "name" = $1 WHERE "id" = $2',
      values: ['Cy', '4'],
    })
  })

  test('no changes gives no statements', () => {
    expect(changeStatements(orders, changes(), ORDERS)).toEqual([])
  })
})

describe('changeStatements: validation', () => {
  test.each<[string, RowChanges]>([
    ['an update value', changes({ updates: [{ key: { id: '1' }, values: { nope: 'x' } }] })],
    ['an insert value', changes({ inserts: [{ values: { nope: 'x' } }] })],
    ['an insert DEFAULT value', changes({ inserts: [{ values: { nope: { default: true } } }] })],
  ])('an unknown column in %s is rejected', (_, change) => {
    expect(() => changeStatements(orders, change, ORDERS)).toThrow(InvalidViewError)
    expect(() => changeStatements(orders, change, ORDERS)).toThrow('Unknown column "nope"')
  })

  test.each<[string, RowChanges]>([
    ['an update key', changes({ updates: [{ key: {}, values: { name: 'x' } }] })],
    ['a delete key', changes({ deletes: [{ key: { name: 'x' } }] })],
  ])('a key without its key column is rejected: %s', (_, change) => {
    expect(() => changeStatements(orders, change, ORDERS)).toThrow('Missing key column "id"')
  })

  test.each<[RowKey]>([[{}], [{ ctid: null }]])('a ctid table row without a ctid is rejected (key %p)', (key) => {
    const plain: RelationShape = { kind: 'r', columns: ['name'], primaryKey: [], estimatedRows: null }
    expect(() => changeStatements(plain, changes({ deletes: [{ key }] }), '"public"."t"')).toThrow(
      'Missing ctid for row',
    )
  })

  test.each(['v', 'm', 'f', 'p'])('a relation of kind %p with no primary key cannot be edited', (kind) => {
    const shape: RelationShape = { kind, columns: ['name'], primaryKey: [], estimatedRows: null }
    expect(() => changeStatements(shape, changes({ deletes: [{ key: { ctid: '(0,1)' } }] }), '"public"."v"')).toThrow(
      'This relation has no primary key and cannot be edited.',
    )
  })
})

describe('assertOne', () => {
  test.each<[number, string, string]>([
    [
      0,
      'update',
      'Could not update a row: it was not found. Someone else may have changed or deleted it. Refresh and try again.',
    ],
    [
      0,
      'delete',
      'Could not delete a row: it was not found. Someone else may have changed or deleted it. Refresh and try again.',
    ],
    [2, 'delete', 'Refusing to delete 2 rows at once: the row key is not unique.'],
    [3, 'update', 'Refusing to update 3 rows at once: the row key is not unique.'],
  ])('%p row(s) for %s is refused', (rowCount, action, message) => {
    expect(() => assertOne(rowCount, action)).toThrow(message)
  })

  test.each<[number, string]>([
    [1, 'update'],
    [1, 'delete'],
  ])('exactly one row for %s passes', (rowCount, action) => {
    expect(() => assertOne(rowCount, action)).not.toThrow()
  })
})
