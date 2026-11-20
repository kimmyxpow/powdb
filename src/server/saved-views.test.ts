import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { SavedView, SavedViewState } from '@/lib/types'
import * as sv from './saved-views.server'

const target = { connectionId: 'c1', database: 'shop', schema: 'public', table: 'orders' }

const emptyState: SavedViewState = { sort: [], filters: [], where: null, q: null, hiddenColumns: [] }

const view = (over: Partial<SavedView>): SavedView => ({
  id: 'a',
  name: 'View',
  ...target,
  state: emptyState,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

describe('pure helpers', () => {
  test('cleanName trims and rejects empty or too long names', () => {
    expect(sv.cleanName('  Open orders  ')).toBe('Open orders')
    expect(() => sv.cleanName('   ')).toThrow('Name is required.')
    expect(() => sv.cleanName('x'.repeat(81))).toThrow('80 characters')
    expect(sv.cleanName('x'.repeat(80))).toHaveLength(80)
  })

  test('cleanState enforces the limits', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `col${i}`)
    expect(() => sv.cleanState({ ...emptyState, hiddenColumns: many(2001) })).toThrow('max 2000')
    expect(() =>
      sv.cleanState({
        ...emptyState,
        sort: Array.from({ length: 21 }, () => ({ column: 'a', direction: 'asc' as const })),
      }),
    ).toThrow('max 20')
    expect(() =>
      sv.cleanState({
        ...emptyState,
        filters: Array.from({ length: 51 }, () => ({ column: 'a', op: 'is_null' as const })),
      }),
    ).toThrow('max 50')
    expect(() => sv.cleanState({ ...emptyState, where: 'x'.repeat(10_001) })).toThrow('SQL condition')
    expect(() => sv.cleanState({ ...emptyState, q: 'x'.repeat(10_001) })).toThrow('search text')
    expect(sv.cleanState({ ...emptyState, where: 'x'.repeat(10_000) }).where).toHaveLength(10_000)
  })

  test('cleanState stores blank text as null and drops duplicate hidden columns', () => {
    const clean = sv.cleanState({
      sort: [{ column: 'id', direction: 'desc' }],
      filters: [{ column: 'name', op: 'is_null', value: undefined }],
      where: '   ',
      q: '',
      hiddenColumns: ['a', 'b', 'a'],
    })
    expect(clean.where).toBeNull()
    expect(clean.q).toBeNull()
    expect(clean.hiddenColumns).toEqual(['a', 'b'])
    expect(clean.filters).toEqual([{ column: 'name', op: 'is_null' }])
  })

  test('isSameTable compares all four parts of the table', () => {
    expect(sv.isSameTable(view({}), target)).toBe(true)
    expect(sv.isSameTable(view({ table: 'users' }), target)).toBe(false)
    expect(sv.isSameTable(view({ schema: 'sales' }), target)).toBe(false)
    expect(sv.isSameTable(view({ database: 'other' }), target)).toBe(false)
    expect(sv.isSameTable(view({ connectionId: 'c2' }), target)).toBe(false)
  })

  test('viewsForTable keeps one table and sorts by name, ignoring case', () => {
    const list = [
      view({ id: '1', name: 'banana' }),
      view({ id: '2', name: 'Apple' }),
      view({ id: '3', name: 'cherry', table: 'users' }),
      view({ id: '4', name: 'apple2' }),
    ]
    expect(sv.viewsForTable(list, target).map((v) => v.id)).toEqual(['2', '4', '1'])
    // the input is not reordered
    expect(list[0]!.id).toBe('1')
  })

  test('assertUniqueName rejects another view with the same name, ignoring case', () => {
    const list = [view({ id: '1', name: 'Open orders' })]
    expect(() => sv.assertUniqueName(list, target, 'open ORDERS')).toThrow(
      'A view named "open ORDERS" already exists for this table.',
    )
    // another table may use the name
    expect(() => sv.assertUniqueName(list, { ...target, table: 'users' }, 'Open orders')).not.toThrow()
    // a view may keep its own name
    expect(() => sv.assertUniqueName(list, target, 'Open orders', '1')).not.toThrow()
  })

  test('assertRoom allows 50 views per table and refuses the 51st', () => {
    const fifty = Array.from({ length: 50 }, (_, i) => view({ id: `v${i}`, name: `V${i}` }))
    expect(() => sv.assertRoom(fifty.slice(0, 49), target)).not.toThrow()
    expect(() => sv.assertRoom(fifty, target)).toThrow('This table already has 50 saved views. Delete one first.')
    // views of other tables do not count
    expect(() =>
      sv.assertRoom(
        fifty.map((v) => ({ ...v, table: 'users' })),
        target,
      ),
    ).not.toThrow()
  })

  test('newViewRecord normalizes the input', () => {
    const v = sv.newViewRecord({ ...target, name: ' Open ', state: emptyState }, 'abc12345', 'now')
    expect(v).toEqual({
      id: 'abc12345',
      name: 'Open',
      ...target,
      state: emptyState,
      createdAt: 'now',
      updatedAt: 'now',
    })
  })

  test('applyViewPatch keeps untouched fields and bumps updatedAt', () => {
    const base = view({ state: { ...emptyState, q: 'x' } })
    const renamed = sv.applyViewPatch(base, { name: ' New ' }, 'later')
    expect(renamed.name).toBe('New')
    expect(renamed.state).toEqual(base.state)
    expect(renamed.updatedAt).toBe('later')
    expect(renamed.createdAt).toBe(base.createdAt)

    const restated = sv.applyViewPatch(base, { state: { ...emptyState, where: 'a > 1' } }, 'later')
    expect(restated.name).toBe('View')
    expect(restated.state.where).toBe('a > 1')
    expect(() => sv.applyViewPatch(base, { name: '' }, 'later')).toThrow('Name is required.')
  })

  test('parseFile: missing or empty is empty, garbage throws', () => {
    expect(sv.parseFile(null)).toEqual([])
    expect(sv.parseFile('   ')).toEqual([])
    expect(sv.parseFile(JSON.stringify({ version: 1, views: [view({})] }))).toHaveLength(1)
    expect(() => sv.parseFile('{not json')).toThrow('not valid JSON')
    expect(() => sv.parseFile(JSON.stringify({ version: 1 }))).toThrow('unexpected format')
  })
})

describe('file-backed store (temp data dir)', () => {
  const originalDir = process.env.POWVIEW_DATA_DIR
  let dir: string

  beforeEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = mkdtempSync(path.join(tmpdir(), 'powview-views-'))
    process.env.POWVIEW_DATA_DIR = dir
  })

  afterAll(() => {
    if (originalDir === undefined) delete process.env.POWVIEW_DATA_DIR
    else process.env.POWVIEW_DATA_DIR = originalDir
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('create, list per table, update, delete', async () => {
    const open = await sv.createSavedView({ ...target, name: 'Open', state: { ...emptyState, q: 'a' } })
    const users = await sv.createSavedView({ ...target, table: 'users', name: 'Active', state: emptyState })
    expect(open.id).toHaveLength(8)

    expect((await sv.listSavedViews(target)).map((v) => v.name)).toEqual(['Open'])
    expect((await sv.listSavedViews({ ...target, table: 'users' })).map((v) => v.id)).toEqual([users.id])

    const renamed = await sv.updateSavedView(open.id, { name: 'Open orders' })
    expect(renamed.name).toBe('Open orders')
    expect(renamed.state.q).toBe('a')

    const restated = await sv.updateSavedView(open.id, { state: { ...emptyState, hiddenColumns: ['id'] } })
    expect(restated.state.hiddenColumns).toEqual(['id'])

    await sv.deleteSavedView(open.id)
    expect(await sv.listSavedViews(target)).toEqual([])
  })

  test('names are unique per table, ignoring case, and a view may keep its own name', async () => {
    const a = await sv.createSavedView({ ...target, name: 'Open', state: emptyState })
    await expect(sv.createSavedView({ ...target, name: 'OPEN', state: emptyState })).rejects.toThrow(
      'already exists for this table',
    )
    // the same name on another table is fine
    await sv.createSavedView({ ...target, table: 'users', name: 'Open', state: emptyState })
    await expect(sv.updateSavedView(a.id, { name: 'open' })).resolves.toMatchObject({ name: 'open' })
    const b = await sv.createSavedView({ ...target, name: 'Other', state: emptyState })
    await expect(sv.updateSavedView(b.id, { name: 'Open' })).rejects.toThrow('already exists for this table')
  })

  test('a table holds at most 50 views', async () => {
    for (let i = 0; i < 50; i++) await sv.createSavedView({ ...target, name: `V${i}`, state: emptyState })
    await expect(sv.createSavedView({ ...target, name: 'One more', state: emptyState })).rejects.toThrow(
      'already has 50 saved views',
    )
  })

  test('unknown ids throw Saved view not found.', async () => {
    await expect(sv.updateSavedView('nope0000', { name: 'x' })).rejects.toThrow('Saved view not found.')
    await expect(sv.deleteSavedView('nope0000')).rejects.toThrow('Saved view not found.')
  })

  test('concurrent saves do not lose each other', async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => sv.createSavedView({ ...target, name: `V${i}`, state: emptyState })),
    )
    const all = await sv.listSavedViews(target)
    expect(all).toHaveLength(25)
    expect(new Set(all.map((v) => v.id)).size).toBe(25)
  })

  test('the file is written with the expected shape', async () => {
    await sv.createSavedView({ ...target, name: 'Shape', state: emptyState })
    const file = JSON.parse(readFileSync(path.join(dir, 'saved-views.json'), 'utf8'))
    expect(file.version).toBe(1)
    expect(file.views[0].name).toBe('Shape')
  })

  test('a corrupt file is reported and not overwritten', async () => {
    writeFileSync(path.join(dir, 'saved-views.json'), '{broken')
    await expect(sv.createSavedView({ ...target, name: 'X', state: emptyState })).rejects.toThrow('not valid JSON')
    expect(readFileSync(path.join(dir, 'saved-views.json'), 'utf8')).toBe('{broken')
  })
})
