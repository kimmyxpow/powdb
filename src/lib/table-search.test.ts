import { describe, expect, test } from 'bun:test'
import { countParams, parseTableSearch, rowsParams } from './table-search'

// Each case: the URL search params in, the parsed search out. A key that is invalid or absent
// is left out of the result (the expected objects below leave such keys out).
const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
  ['empty', {}, {}],
  [
    'all valid',
    {
      tab: 'structure',
      page: 3,
      size: 250,
      sort: [
        { column: 'id', direction: 'desc' },
        { column: 'name', direction: 'asc' },
      ],
      filters: [
        { column: 'id', op: 'gte', value: '10' },
        { column: 'name', op: 'is_null' },
      ],
      where: 'a > 1',
      q: 'needle',
    },
    {
      tab: 'structure',
      page: 3,
      size: 250,
      sort: [
        { column: 'id', direction: 'desc' },
        { column: 'name', direction: 'asc' },
      ],
      filters: [
        { column: 'id', op: 'gte', value: '10' },
        { column: 'name', op: 'is_null' },
      ],
      where: 'a > 1',
      q: 'needle',
    },
  ],
  ['numeric strings are coerced', { page: '2', size: '100' }, { page: 2, size: 100 }],
  ['page below 1 is dropped', { page: 0 }, {}],
  ['page not an integer is dropped', { page: 2.5 }, {}],
  ['size above 5000 is dropped', { size: 5001 }, {}],
  ['size at the maximum is kept', { size: 5000 }, { size: 5000 }],
  ['page NaN is dropped', { page: 'abc' }, {}],
  ['page Infinity is dropped', { page: Infinity }, {}],
  ['page null is dropped', { page: null }, {}],
  ['page boolean is coerced like Number()', { page: true }, { page: 1 }],
  ['page empty string is dropped', { page: '' }, {}],
  ['unknown tab is dropped', { tab: 'nope' }, {}],
  ['tab null is dropped', { tab: null }, {}],
  ['sort with a bad direction drops all of sort', { sort: [{ column: 'a', direction: 'up' }] }, {}],
  ['sort not an array is dropped', { sort: 'a' }, {}],
  ['sort element that is an array is dropped', { sort: [['a']] }, {}],
  ['sort element with a number column is dropped', { sort: [{ column: 1, direction: 'asc' }] }, {}],
  [
    'sort extra keys are stripped',
    { sort: [{ column: 'a', direction: 'asc', extra: 1 }] },
    { sort: [{ column: 'a', direction: 'asc' }] },
  ],
  ['empty sort is kept', { sort: [] }, { sort: [] }],
  ['filter with an unknown op drops all of filters', { filters: [{ column: 'a', op: 'zzz' }] }, {}],
  ['filter value that is a number drops all of filters', { filters: [{ column: 'a', op: 'eq', value: 5 }] }, {}],
  ['filter value null drops all of filters', { filters: [{ column: 'a', op: 'eq', value: null }] }, {}],
  [
    'filter without value is kept without the key',
    { filters: [{ column: 'a', op: 'is_null' }] },
    { filters: [{ column: 'a', op: 'is_null' }] },
  ],
  ['empty filters is kept', { filters: [] }, { filters: [] }],
  ['where not a string is dropped', { where: 3 }, {}],
  ['q null is dropped', { q: null }, {}],
  ['empty q is kept', { q: '' }, { q: '' }],
  ['unknown keys are stripped', { foo: 'bar', page: 2 }, { page: 2 }],
]

describe('parseTableSearch', () => {
  for (const [name, input, expected] of cases) {
    test(name, () => {
      const actual = parseTableSearch(input)
      expect(actual).toEqual(expected)
      expect(JSON.stringify(actual)).toBe(JSON.stringify(expected))
    })
  }
})

describe('invalid values stay as undefined keys (the router merges over the raw params)', () => {
  test('bad sort, filters and page are present with undefined', () => {
    const out = parseTableSearch({ sort: 'notjson', filters: [1], page: 'abc', q: 'x' })
    expect('sort' in out && out.sort === undefined).toBe(true)
    expect('filters' in out && out.filters === undefined).toBe(true)
    expect('page' in out && out.page === undefined).toBe(true)
    expect(out.q).toBe('x')
    expect('where' in out).toBe(false)
  })
})

describe('rowsParams', () => {
  test('defaults: first page, the user default size, no sort, no filters', () => {
    const params = rowsParams({}, 250)
    expect(params).toEqual({ page: 1, pageSize: 250, sort: [], filters: [], where: undefined, search: undefined })
    expect(Object.keys(params)).toEqual(['page', 'pageSize', 'sort', 'filters', 'where', 'search'])
  })

  test('URL values pass through, and a URL size wins over the default', () => {
    const search = {
      page: 4,
      size: 500,
      sort: [{ column: 'id', direction: 'desc' as const }],
      filters: [{ column: 'a', op: 'eq' as const, value: '1' }],
      where: 'b > 2',
      q: 'needle',
    }
    expect(rowsParams(search, 100)).toEqual({
      page: 4,
      pageSize: 500,
      sort: search.sort,
      filters: search.filters,
      where: 'b > 2',
      search: 'needle',
    })
  })
})

describe('countParams', () => {
  test('defaults: no filters, no where, no search, and no paging keys', () => {
    const params = countParams({ page: 3, size: 50 })
    expect(params).toEqual({ filters: [], where: undefined, search: undefined })
    expect(Object.keys(params)).toEqual(['filters', 'where', 'search'])
  })

  test('filters, where and q pass through', () => {
    const filters = [{ column: 'a', op: 'is_null' as const }]
    expect(countParams({ filters, where: 'x = 1', q: 'y' })).toEqual({ filters, where: 'x = 1', search: 'y' })
  })
})
