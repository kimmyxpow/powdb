import { describe, expect, test } from 'bun:test'
import type { SavedViewState } from '@/lib/types'
import {
  currentViewState,
  existingHiddenColumns,
  isEmptyViewState,
  sameViewState,
  savedViewSearch,
} from './saved-views'

const empty: SavedViewState = { sort: [], filters: [], where: null, q: null, hiddenColumns: [] }

describe('sameViewState', () => {
  test('the same state is equal', () => {
    expect(sameViewState(empty, { ...empty })).toBe(true)
    const full: SavedViewState = {
      sort: [{ column: 'id', direction: 'desc' }],
      filters: [{ column: 'total', op: 'gt', value: '10' }],
      where: 'a > 1',
      q: 'needle',
      hiddenColumns: ['notes'],
    }
    expect(sameViewState(full, structuredClone(full))).toBe(true)
  })

  test('hidden columns in another order are equal', () => {
    expect(sameViewState({ ...empty, hiddenColumns: ['a', 'b'] }, { ...empty, hiddenColumns: ['b', 'a'] })).toBe(true)
  })

  test('sort and filters in another order are different', () => {
    const s1 = { column: 'a', direction: 'asc' as const }
    const s2 = { column: 'b', direction: 'desc' as const }
    expect(sameViewState({ ...empty, sort: [s1, s2] }, { ...empty, sort: [s2, s1] })).toBe(false)
    const f1 = { column: 'a', op: 'eq' as const, value: '1' }
    const f2 = { column: 'b', op: 'eq' as const, value: '2' }
    expect(sameViewState({ ...empty, filters: [f1, f2] }, { ...empty, filters: [f2, f1] })).toBe(false)
  })

  test('a different sort direction, operator or value is different', () => {
    expect(
      sameViewState(
        { ...empty, sort: [{ column: 'a', direction: 'asc' }] },
        { ...empty, sort: [{ column: 'a', direction: 'desc' }] },
      ),
    ).toBe(false)
    expect(
      sameViewState(
        { ...empty, filters: [{ column: 'a', op: 'eq', value: '1' }] },
        { ...empty, filters: [{ column: 'a', op: 'neq', value: '1' }] },
      ),
    ).toBe(false)
    expect(
      sameViewState(
        { ...empty, filters: [{ column: 'a', op: 'eq', value: '1' }] },
        { ...empty, filters: [{ column: 'a', op: 'eq', value: '2' }] },
      ),
    ).toBe(false)
  })

  test('a missing filter value equals an empty one; blank text equals null', () => {
    expect(
      sameViewState(
        { ...empty, filters: [{ column: 'a', op: 'is_null' }] },
        { ...empty, filters: [{ column: 'a', op: 'is_null', value: '' }] },
      ),
    ).toBe(true)
    expect(sameViewState({ ...empty, q: '  ' }, empty)).toBe(true)
    expect(sameViewState({ ...empty, where: 'x > 1' }, empty)).toBe(false)
    expect(sameViewState({ ...empty, q: 'x' }, { ...empty, q: 'X' })).toBe(false)
  })

  test('a different set of hidden columns is different', () => {
    expect(sameViewState({ ...empty, hiddenColumns: ['a'] }, { ...empty, hiddenColumns: ['a', 'b'] })).toBe(false)
  })
})

describe('currentViewState', () => {
  test('reads the table search and the hidden columns', () => {
    expect(
      currentViewState(
        {
          page: 3,
          sort: [{ column: 'id', direction: 'desc' }],
          filters: [{ column: 'a', op: 'eq', value: '1' }],
          where: 'b > 2',
          q: 'x',
        },
        ['notes'],
      ),
    ).toEqual({
      sort: [{ column: 'id', direction: 'desc' }],
      filters: [{ column: 'a', op: 'eq', value: '1' }],
      where: 'b > 2',
      q: 'x',
      hiddenColumns: ['notes'],
    })
  })

  test('missing search fields are empty', () => {
    expect(currentViewState({}, [])).toEqual(empty)
    expect(currentViewState({ where: '', q: '' }, [])).toEqual(empty)
  })

  test('a saved view of the current state matches it', () => {
    const search = { filters: [{ column: 'a', op: 'eq' as const, value: '1' }], q: 'x' }
    const state = currentViewState(search, ['b'])
    expect(sameViewState(state, currentViewState({ ...search }, ['b']))).toBe(true)
  })
})

describe('isEmptyViewState', () => {
  test('empty only when nothing is set', () => {
    expect(isEmptyViewState(empty)).toBe(true)
    expect(isEmptyViewState({ ...empty, q: '  ' })).toBe(true)
    expect(isEmptyViewState({ ...empty, sort: [{ column: 'a', direction: 'asc' }] })).toBe(false)
    expect(isEmptyViewState({ ...empty, filters: [{ column: 'a', op: 'is_null' }] })).toBe(false)
    expect(isEmptyViewState({ ...empty, where: 'a > 1' })).toBe(false)
    expect(isEmptyViewState({ ...empty, q: 'x' })).toBe(false)
    expect(isEmptyViewState({ ...empty, hiddenColumns: ['a'] })).toBe(false)
  })
})

describe('existingHiddenColumns', () => {
  test('drops hidden columns the table no longer has', () => {
    expect(existingHiddenColumns(['a', 'gone'], ['a', 'b', 'c'])).toEqual(['a'])
  })

  test('never hides every column', () => {
    expect(existingHiddenColumns(['a', 'b'], ['a', 'b'])).toEqual([])
    expect(existingHiddenColumns(['x'], ['a'])).toEqual([])
  })

  test('removes duplicates', () => {
    expect(existingHiddenColumns(['a', 'a'], ['a', 'b'])).toEqual(['a'])
  })
})

describe('savedViewSearch', () => {
  test('an empty state gives an empty search', () => {
    expect(savedViewSearch(empty)).toEqual({})
  })

  test('only the parts that are set are kept, and hidden columns are not part of the search', () => {
    expect(
      savedViewSearch({
        sort: [{ column: 'id', direction: 'desc' }],
        filters: [],
        where: null,
        q: 'needle',
        hiddenColumns: ['notes'],
      }),
    ).toEqual({ sort: [{ column: 'id', direction: 'desc' }], q: 'needle' })
  })

  test('filters and SQL condition are copied', () => {
    const state: SavedViewState = {
      ...empty,
      filters: [{ column: 'total', op: 'gt', value: '10' }],
      where: 'a > 1',
    }
    expect(savedViewSearch(state)).toEqual({ filters: [{ column: 'total', op: 'gt', value: '10' }], where: 'a > 1' })
  })
})
