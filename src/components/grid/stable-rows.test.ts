import { describe, expect, test } from 'bun:test'
import {
  createIdentityBox,
  createKeyedCache,
  issuesWithServerIssue,
  keepIdentity,
  sameData,
  sameElements,
  storedGridRow,
  type StoredRowInput,
} from './stable-rows'
import type { GridValue } from './types'

const noIssues = () => null

function stored(id: string, values: GridValue[], extra: Partial<StoredRowInput> = {}): StoredRowInput {
  return { id, values, edits: undefined, deleted: false, serverIssue: undefined, ...extra }
}

describe('createKeyedCache', () => {
  test('same key and same inputs give the same object', () => {
    const cache = createKeyedCache()
    const a = { n: 1 }
    const first = cache.get('k', [a], () => ({ made: true }))
    const second = cache.get('k', [a], () => ({ made: false }))
    expect(second).toBe(first)
  })

  test('a changed input makes a new object, other keys keep theirs', () => {
    const cache = createKeyedCache()
    const x = cache.get('a', [1], () => ({}))
    const y = cache.get('b', [1], () => ({}))
    expect(cache.get('a', [2], () => ({}))).not.toBe(x)
    expect(cache.get('b', [1], () => ({}))).toBe(y)
  })

  test('retain drops the keys that are gone', () => {
    const cache = createKeyedCache()
    const a = cache.get('a', [1], () => ({}))
    cache.get('b', [1], () => ({}))
    cache.retain(new Set(['a']))
    expect(cache.get('a', [1], () => ({}))).toBe(a)
    expect(cache.get('b', [1], () => ({}))).not.toBeUndefined()
  })
})

describe('storedGridRow', () => {
  const columns = [{ name: 'a' }, { name: 'b' }]
  const validate = (value: GridValue) => (value === 'bad' ? 'Invalid' : null)

  test('the same inputs give the same row object', () => {
    const cache = createKeyedCache()
    const values: GridValue[] = ['x', 'y']
    const first = storedGridRow(cache, stored('r1', values), columns, noIssues)
    const second = storedGridRow(cache, stored('r1', values), columns, noIssues)
    expect(second).toBe(first)
  })

  test('an edit gives a new object for that row only', () => {
    const cache = createKeyedCache()
    const rows = [stored('r1', ['x', 'y']), stored('r2', ['p', 'q']), stored('r3', ['m', 'n'])]
    const before = rows.map((r) => storedGridRow(cache, r, columns, noIssues))
    const edited = new Map<number, GridValue>([[1, 'changed']])
    const after = rows.map((r) => storedGridRow(cache, r.id === 'r2' ? { ...r, edits: edited } : r, columns, noIssues))
    expect(after[0]).toBe(before[0]!)
    expect(after[1]).not.toBe(before[1]!)
    expect(after[1]!.values).toEqual(['p', 'changed'])
    expect(after[1]!.edited).toEqual(new Set([1]))
    expect(after[2]).toBe(before[2]!)
  })

  test('a changed column shape rebuilds the row', () => {
    const cache = createKeyedCache()
    const values: GridValue[] = ['x', 'y']
    const first = storedGridRow(cache, stored('r1', values), columns, noIssues)
    expect(storedGridRow(cache, stored('r1', values), [...columns], noIssues)).not.toBe(first)
  })

  test('validation problems and the save error mark their cells; deleted rows get no validation', () => {
    const cache = createKeyedCache()
    const edits = new Map<number, GridValue>([[0, 'bad']])
    const row = storedGridRow(cache, stored('r1', ['x', 'y'], { edits }), columns, validate)
    expect(row.issues?.get(0)).toBe('Invalid')
    const withServer = storedGridRow(
      createKeyedCache(),
      stored('r1', ['x', 'y'], { serverIssue: { cols: [1], message: 'Duplicate key' } }),
      columns,
      validate,
    )
    expect(withServer.issues?.get(1)).toBe('Duplicate key')
    const deleted = storedGridRow(
      createKeyedCache(),
      stored('r1', ['x', 'y'], { edits, deleted: true }),
      columns,
      validate,
    )
    expect(deleted.status).toBe('deleted')
    expect(deleted.issues).toBeUndefined()
  })
})

describe('issuesWithServerIssue', () => {
  test('keeps an existing message for a column', () => {
    const issues = new Map([[0, 'Required']])
    const merged = issuesWithServerIssue(issues, { cols: [0, 1], message: 'Server' })
    expect(merged?.get(0)).toBe('Required')
    expect(merged?.get(1)).toBe('Server')
  })

  test('undefined when there is nothing to show', () => {
    expect(issuesWithServerIssue(new Map(), undefined)).toBeUndefined()
  })
})

describe('keepIdentity', () => {
  test('keeps the previous array while its elements are the same objects', () => {
    const box = createIdentityBox<object[]>()
    const a = {}
    const b = {}
    const first = keepIdentity(box, [a, b], sameElements)
    expect(keepIdentity(box, [a, b], sameElements)).toBe(first)
    expect(keepIdentity(box, [a, {}], sameElements)).not.toBe(first)
  })

  test('deep equality for columns: equal content keeps the old array, a changed label does not', () => {
    const box = createIdentityBox<unknown[]>()
    const make = (label: string) => [{ name: 'id', refLabels: new Map([['1', { label, detail: null }]]) }]
    const first = keepIdentity(box, make('Ada'), sameData)
    expect(keepIdentity(box, make('Ada'), sameData)).toBe(first)
    expect(keepIdentity(box, make('Grace'), sameData)).not.toBe(first)
  })
})

describe('sameData', () => {
  test('compares plain data by content', () => {
    expect(sameData({ a: [1, { b: 'x' }] }, { a: [1, { b: 'x' }] })).toBe(true)
    expect(sameData({ a: [1] }, { a: [2] })).toBe(false)
    expect(sameData({ a: undefined }, {})).toBe(false)
    expect(sameData(new Map([[1, 'a']]), new Map([[1, 'a']]))).toBe(true)
    expect(sameData(new Map([[1, 'a']]), new Map([[1, 'b']]))).toBe(false)
  })
})
