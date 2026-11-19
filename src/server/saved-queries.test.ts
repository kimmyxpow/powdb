import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { SavedQuery } from '@/lib/types'
import * as sq from './saved-queries.server'

const query = (over: Partial<SavedQuery>): SavedQuery => ({
  id: 'a',
  name: 'Query',
  sql: 'select 1',
  connectionId: 'c1',
  database: 'shop',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

describe('pure helpers', () => {
  test('cleanName trims and rejects empty or too long names', () => {
    expect(sq.cleanName('  Monthly sales  ')).toBe('Monthly sales')
    expect(() => sq.cleanName('   ')).toThrow('Name is required.')
    expect(() => sq.cleanName('x'.repeat(121))).toThrow('120 characters')
    expect(sq.cleanName('x'.repeat(120))).toHaveLength(120)
  })

  test('checkSql rejects more than 1 MB', () => {
    expect(() => sq.checkSql('x'.repeat(sq.SAVED_QUERY_SQL_MAX + 1))).toThrow('max 1 MB')
    expect(sq.checkSql('select 1')).toBe('select 1')
  })

  test('visibility: own connection and all connections only', () => {
    const all = query({ id: 'all', connectionId: null })
    const own = query({ id: 'own', connectionId: 'c1' })
    const other = query({ id: 'other', connectionId: 'c2' })
    expect(sq.isVisibleFor(all, 'c1')).toBe(true)
    expect(sq.isVisibleFor(own, 'c1')).toBe(true)
    expect(sq.isVisibleFor(other, 'c1')).toBe(false)
    expect(
      sq
        .visibleQueries([other, own, all], 'c1')
        .map((q) => q.id)
        .sort(),
    ).toEqual(['all', 'own'])
  })

  test('sorting puts the newest update first', () => {
    const list = [
      query({ id: 'old', updatedAt: '2026-01-01T00:00:00.000Z' }),
      query({ id: 'new', updatedAt: '2026-03-01T00:00:00.000Z' }),
      query({ id: 'mid', updatedAt: '2026-02-01T00:00:00.000Z' }),
    ]
    expect(sq.sortNewestFirst(list).map((q) => q.id)).toEqual(['new', 'mid', 'old'])
    // input is not mutated
    expect(list[0]!.id).toBe('old')
  })

  test('newQueryRecord normalizes the input', () => {
    const q = sq.newQueryRecord(
      { name: ' Sales ', sql: 'select 1', connectionId: '', database: '  ' },
      'abc12345',
      'now',
    )
    expect(q).toEqual({
      id: 'abc12345',
      name: 'Sales',
      sql: 'select 1',
      connectionId: null,
      database: null,
      createdAt: 'now',
      updatedAt: 'now',
    })
  })

  test('applyPatch keeps untouched fields, allows null scope, and bumps updatedAt', () => {
    const base = query({})
    const next = sq.applyPatch(base, { sql: 'select 2' }, 'later')
    expect(next.sql).toBe('select 2')
    expect(next.name).toBe('Query')
    expect(next.connectionId).toBe('c1')
    expect(next.updatedAt).toBe('later')
    expect(next.createdAt).toBe(base.createdAt)

    const shared = sq.applyPatch(base, { connectionId: null }, 'later')
    expect(shared.connectionId).toBeNull()
    expect(() => sq.applyPatch(base, { name: '' }, 'later')).toThrow('Name is required.')
  })

  test('newId avoids taken ids', () => {
    const id = sq.newId(new Set(['x']))
    expect(id).toHaveLength(8)
    expect(id).not.toBe('x')
  })

  test('parseFile: missing or empty is empty, garbage throws', () => {
    expect(sq.parseFile(null)).toEqual([])
    expect(sq.parseFile('   ')).toEqual([])
    expect(sq.parseFile(JSON.stringify({ version: 1, queries: [query({})] }))).toHaveLength(1)
    expect(() => sq.parseFile('{not json')).toThrow('not valid JSON')
    expect(() => sq.parseFile(JSON.stringify({ version: 1 }))).toThrow('unexpected format')
  })
})

describe('file-backed store (temp data dir)', () => {
  const originalDir = process.env.POWVIEW_DATA_DIR
  let dir: string

  beforeEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = mkdtempSync(path.join(tmpdir(), 'powview-saved-'))
    process.env.POWVIEW_DATA_DIR = dir
  })

  afterAll(() => {
    if (originalDir === undefined) delete process.env.POWVIEW_DATA_DIR
    else process.env.POWVIEW_DATA_DIR = originalDir
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('create, list per connection, update, delete', async () => {
    const mine = await sq.createSavedQuery({ name: 'Mine', sql: 'select 1', connectionId: 'c1', database: 'shop' })
    const shared = await sq.createSavedQuery({ name: 'Shared', sql: 'select 2', connectionId: null, database: null })
    const theirs = await sq.createSavedQuery({ name: 'Theirs', sql: 'select 3', connectionId: 'c2', database: 'x' })
    expect(mine.id).toHaveLength(8)

    const onC1 = (await sq.listSavedQueries('c1')).map((q) => q.name).sort()
    expect(onC1).toEqual(['Mine', 'Shared'])
    expect((await sq.listSavedQueries('c2')).map((q) => q.id).sort()).toEqual([shared.id, theirs.id].sort())

    const renamed = await sq.updateSavedQuery(mine.id, { name: '  Renamed ' })
    expect(renamed.name).toBe('Renamed')
    expect(renamed.sql).toBe('select 1')

    await sq.updateSavedQuery(mine.id, { connectionId: null })
    expect((await sq.listSavedQueries('c2')).some((q) => q.id === mine.id)).toBe(true)

    await sq.deleteSavedQuery(shared.id)
    expect((await sq.listSavedQueries('c1')).map((q) => q.id)).toEqual([mine.id])
  })

  test('unknown ids throw Saved query not found.', async () => {
    await expect(sq.updateSavedQuery('nope0000', { sql: 'x' })).rejects.toThrow('Saved query not found.')
    await expect(sq.deleteSavedQuery('nope0000')).rejects.toThrow('Saved query not found.')
  })

  test('duplicate names are allowed', async () => {
    const a = await sq.createSavedQuery({ name: 'Same', sql: 'select 1', connectionId: null, database: null })
    const b = await sq.createSavedQuery({ name: 'Same', sql: 'select 2', connectionId: null, database: null })
    expect(a.id).not.toBe(b.id)
    expect(await sq.listSavedQueries('c1')).toHaveLength(2)
  })

  test('concurrent saves do not lose each other', async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        sq.createSavedQuery({ name: `Q${i}`, sql: `select ${i}`, connectionId: null, database: null }),
      ),
    )
    const all = await sq.listSavedQueries('any')
    expect(all).toHaveLength(25)
    expect(new Set(all.map((q) => q.id)).size).toBe(25)
  })

  test('the file is written with the expected shape', async () => {
    await sq.createSavedQuery({ name: 'Shape', sql: 'select 1', connectionId: null, database: null })
    const file = JSON.parse(readFileSync(path.join(dir, 'saved-queries.json'), 'utf8'))
    expect(file.version).toBe(1)
    expect(file.queries[0].name).toBe('Shape')
  })

  test('a corrupt file is reported and not overwritten', async () => {
    writeFileSync(path.join(dir, 'saved-queries.json'), '{broken')
    await expect(
      sq.createSavedQuery({ name: 'X', sql: 'select 1', connectionId: null, database: null }),
    ).rejects.toThrow('not valid JSON')
    expect(readFileSync(path.join(dir, 'saved-queries.json'), 'utf8')).toBe('{broken')
  })
})
