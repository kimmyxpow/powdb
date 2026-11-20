import { describe, expect, test } from 'bun:test'
import { mapFullReads, mapStatementRows, mapUnusedIndexes, mapVacuum, statementsFailure } from './health.server'

describe('mapStatementRows', () => {
  test('converts counts from strings to numbers', () => {
    const [row] = mapStatementRows([
      { query: 'SELECT 1', calls: '42', total_ms: 1200.5, mean_ms: 28.6, rows: '420', share: 0.25 },
    ])
    expect(row).toEqual({ query: 'SELECT 1', calls: 42, totalMs: 1200.5, meanMs: 28.6, rows: 420, share: 0.25 })
  })

  test('shows the hidden text of another role as null', () => {
    const [row] = mapStatementRows([
      { query: '<insufficient privilege>', calls: '1', total_ms: 1, mean_ms: 1, rows: '0', share: 0.1 },
    ])
    expect(row?.query).toBeNull()
  })

  test('a share that PostgreSQL could not compute counts as 0', () => {
    const [row] = mapStatementRows([{ query: 'SELECT 2', calls: 1, total_ms: 0, mean_ms: 0, rows: 0, share: null }])
    expect(row?.share).toBe(0)
  })
})

describe('statementsFailure', () => {
  test('a missing shared_preload_libraries entry is not-loaded, with no message', () => {
    expect(statementsFailure('pg_stat_statements must be loaded via "shared_preload_libraries".')).toEqual({
      status: 'not-loaded',
      message: null,
      rows: [],
    })
  })

  test('any other error is error, with the Postgres message', () => {
    expect(statementsFailure('permission denied for view pg_stat_statements')).toEqual({
      status: 'error',
      message: 'permission denied for view pg_stat_statements',
      rows: [],
    })
  })
})

describe('health row mapping', () => {
  test('unused indexes read their size as a number', () => {
    expect(mapUnusedIndexes([{ schema: 'public', table: 'orders', index: 'orders_note_idx', bytes: '8192' }])).toEqual([
      { schema: 'public', table: 'orders', index: 'orders_note_idx', bytes: 8192 },
    ])
  })

  test('vacuum rows read counts as numbers and the last vacuum as an ISO string', () => {
    const at = new Date('2026-11-01T10:00:00.000Z')
    expect(
      mapVacuum([{ schema: 'public', table: 'events', dead_rows: '5000', live_rows: '900', last_vacuum: at }]),
    ).toEqual([{ schema: 'public', table: 'events', deadRows: 5000, liveRows: 900, lastVacuum: at.toISOString() }])
    expect(
      mapVacuum([{ schema: 'public', table: 'events', dead_rows: 5000, live_rows: 900, last_vacuum: null }])[0]
        ?.lastVacuum,
    ).toBeNull()
  })

  test('full reads read every count as a number', () => {
    expect(
      mapFullReads([
        { schema: 'public', table: 'logs', seq_scan: '120', idx_scan: '3', rows_read: '9000000', live_rows: '50000' },
      ]),
    ).toEqual([{ schema: 'public', table: 'logs', seqScans: 120, indexScans: 3, rowsRead: 9000000, liveRows: 50000 }])
  })
})
