import { describe, expect, test } from 'bun:test'
import type pg from 'pg'
import {
  canDeclareCursor,
  closeSql,
  declareSql,
  fetchSql,
  newCursorName,
  readInBatches,
  readStatementRows,
} from './cursor.server'

const FIELD = { name: 'n' } as pg.FieldDef

interface Reply {
  rows: unknown[][]
  fields: pg.FieldDef[]
  command: string
  rowCount: number | null
}

/**
 * Stand-in for a pg client: records every SQL text it is sent. FETCH returns the next page
 * from `pages` (an empty result once they run out). `respond` answers anything else.
 */
function fakeClient(
  pages: unknown[][][] = [],
  respond: (text: string) => Reply | Error | undefined = () => undefined,
  options: { failFetch?: Error } = {},
) {
  const sent: string[] = []
  let page = 0
  const client = {
    async query(config: string | { text: string }) {
      const text = typeof config === 'string' ? config : config.text
      sent.push(text)
      if (text.startsWith('FETCH')) {
        if (options.failFetch) throw options.failFetch
        const rows = pages[page++] ?? []
        return { rows, fields: [FIELD], command: 'FETCH', rowCount: rows.length }
      }
      const reply = respond(text)
      if (reply instanceof Error) throw reply
      return reply ?? { rows: [], fields: [], command: 'OK', rowCount: null }
    },
  }
  return { client: client as unknown as pg.ClientBase, sent }
}

describe('cursor names and SQL', () => {
  test('names are powdbs_cur_ plus 32 hex characters, and differ between calls', () => {
    const a = newCursorName()
    const b = newCursorName()
    expect(a).toMatch(/^powdbs_cur_[0-9a-f]{32}$/)
    expect(b).not.toBe(a)
    expect(newCursorName('abc')).toBe('powdbs_cur_abc')
  })

  test('DECLARE drops the trailing semicolon and whitespace', () => {
    expect(declareSql('c1', 'SELECT 1;\n')).toBe('DECLARE c1 NO SCROLL CURSOR FOR SELECT 1')
    expect(declareSql('c1', 'SELECT $1 FROM t WHERE a = $2')).toBe(
      'DECLARE c1 NO SCROLL CURSOR FOR SELECT $1 FROM t WHERE a = $2',
    )
  })

  test('FETCH and CLOSE', () => {
    expect(fetchSql('c1', 500)).toBe('FETCH FORWARD 500 FROM c1')
    expect(closeSql('c1')).toBe('CLOSE c1')
  })
})

describe('canDeclareCursor', () => {
  test.each([
    'SELECT 1',
    '  select * from t',
    '(SELECT 1) UNION (SELECT 2)',
    'VALUES (1), (2)',
    'TABLE accounts',
    'WITH x AS (SELECT 1) SELECT * FROM x',
    '-- note\nSELECT 1',
    '/* hi */ SELECT 1',
    "SELECT * FROM orders WHERE note LIKE '%into%'",
    'SELECT updated_at, inserted_by FROM t',
    '-- update this later\nSELECT 1',
    '-- note\rSELECT 1',
  ])('accepts read-only %p', (sql) => {
    expect(canDeclareCursor(sql)).toBe(true)
  })

  test.each([
    'UPDATE t SET a = 1 RETURNING a',
    'INSERT INTO t VALUES (1)',
    'DELETE FROM t RETURNING *',
    'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d',
    'SELECT * INTO copy_t FROM t',
    'CREATE TABLE x (a int)',
    'EXPLAIN SELECT 1',
    'SHOW search_path',
    'BEGIN',
    '-- only a comment',
    '',
  ])('sends %p down the plain-query path', (sql) => {
    expect(canDeclareCursor(sql)).toBe(false)
  })
})

describe('readInBatches', () => {
  test('opens its own transaction, reads in batches, closes and commits', async () => {
    const { client, sent } = fakeClient([[[1], [2]], [[3]]])
    const batches: unknown[][][] = []
    for await (const batch of readInBatches(client, 'SELECT n FROM t;', [], 2, { rowMode: 'array' })) {
      batches.push(batch.rows)
    }
    expect(batches).toEqual([[[1], [2]], [[3]]])
    expect(sent[0]).toBe('BEGIN')
    expect(sent[1]).toMatch(/^DECLARE powdbs_cur_[0-9a-f]{32} NO SCROLL CURSOR FOR SELECT n FROM t$/)
    const name = sent[1]!.split(' ')[1]!
    expect(sent).toEqual(['BEGIN', sent[1]!, fetchSql(name, 2), fetchSql(name, 2), closeSql(name), 'COMMIT'])
  })

  test('joins a transaction the caller opened: no BEGIN or COMMIT', async () => {
    const { client, sent } = fakeClient([[[7]]])
    const rows: unknown[][] = []
    for await (const batch of readInBatches(client, 'SELECT 7', [], 5, { inTransaction: true })) {
      rows.push(...batch.rows)
    }
    expect(rows).toEqual([[7]])
    expect(sent.some((s) => s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK')).toBe(false)
    expect(sent[sent.length - 1]).toMatch(/^CLOSE powdbs_cur_/)
  })

  test('returning early still closes the cursor and commits the owned transaction', async () => {
    const { client, sent } = fakeClient([
      [[1], [2]],
      [[3], [4]],
    ])
    for await (const batch of readInBatches(client, 'SELECT n FROM t', [], 2)) {
      expect(batch.rows).toHaveLength(2)
      break
    }
    expect(sent[sent.length - 2]).toMatch(/^CLOSE powdbs_cur_/)
    expect(sent[sent.length - 1]).toBe('COMMIT')
  })

  test('an error from FETCH rolls back the owned transaction and rethrows', async () => {
    const boom = new Error('canceling statement due to statement timeout')
    const { client, sent } = fakeClient([], undefined, { failFetch: boom })
    await expect(async () => {
      for await (const _ of readInBatches(client, 'SELECT 1', [], 2)) void _
    }).toThrow(boom)
    expect(sent[sent.length - 2]).toMatch(/^CLOSE powdbs_cur_/)
    expect(sent[sent.length - 1]).toBe('ROLLBACK')
  })

  test('rejects a batch size that is not a positive integer', async () => {
    const { client } = fakeClient()
    await expect(
      (async () => {
        for await (const _ of readInBatches(client, 'SELECT 1', [], 0)) void _
      })(),
    ).rejects.toThrow(RangeError)
  })
})

describe('readStatementRows', () => {
  test('SELECT streams through a cursor and stops at the limit', async () => {
    const { client, sent } = fakeClient([[[1], [2], [3]]])
    const res = await readStatementRows(client, 'SELECT n FROM t', 2)
    expect(res.rows).toEqual([[1], [2]])
    expect(res.command).toBe('SELECT')
    expect(res.fields).toEqual([FIELD])
    expect(sent[0]).toBe('BEGIN')
    expect(sent[sent.length - 1]).toBe('COMMIT')
  })

  test('a SELECT inside the caller transaction sends no BEGIN or COMMIT', async () => {
    const { client, sent } = fakeClient([[[1]]])
    const res = await readStatementRows(client, 'SELECT n FROM t', 5, { inTransaction: true })
    expect(res.rows).toEqual([[1]])
    expect(res.rowCount).toBe(1)
    expect(sent.some((s) => s === 'BEGIN' || s === 'COMMIT')).toBe(false)
  })

  test('DML runs as one ordinary query and keeps its command and row count', async () => {
    const { client, sent } = fakeClient([], (text) =>
      text.startsWith('UPDATE') ? { rows: [[10], [11]], fields: [FIELD], command: 'UPDATE', rowCount: 2 } : undefined,
    )
    const res = await readStatementRows(client, 'UPDATE t SET n = n + 1 RETURNING n', 3)
    expect(sent).toEqual(['UPDATE t SET n = n + 1 RETURNING n'])
    expect(res).toEqual({ rows: [[10], [11]], fields: [FIELD], command: 'UPDATE', rowCount: 2 })
  })
})
