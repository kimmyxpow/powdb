import { describe, expect, test } from 'bun:test'
import { isReadOnlySql, runAgentQuery } from './agent.server'

describe('isReadOnlySql accepts read statements', () => {
  const accepted = [
    'select 1',
    '  -- c\n WITH x AS (select 1) select * from x',
    '(select 1)',
    '((select 1))',
    '/* note */ select 1',
    'explain select 1',
    'show search_path',
    'values (1)',
    'table t',
    'select 1;',
  ]
  for (const sql of accepted) {
    test(`accepts ${JSON.stringify(sql)}`, () => {
      expect(isReadOnlySql(sql)).toEqual({ ok: true })
    })
  }
})

describe('isReadOnlySql rejects everything else', () => {
  const rejected = [
    'delete from t',
    'select 1; select 2',
    'set transaction_read_only = off',
    'commit',
    'begin',
    'do $$ begin end $$',
    'copy t to stdout',
    'insert into t values (1)',
    '',
    '   -- only a comment',
  ]
  for (const sql of rejected) {
    test(`rejects ${JSON.stringify(sql)}`, () => {
      const verdict = isReadOnlySql(sql)
      expect(verdict.ok).toBe(false)
      if (!verdict.ok) {
        expect(verdict.reason).toBe(
          'Only one read-only statement (SELECT, WITH, EXPLAIN, SHOW, VALUES, TABLE) is allowed with read access.',
        )
      }
    })
  }
})

// These are refused before any connection is opened, so no database is needed.
describe('runAgentQuery refuses before connecting', () => {
  test('a read that is not a read-only statement', async () => {
    await expect(
      runAgentQuery({ connectionId: 'no-such-connection', sql: 'delete from t', access: 'read' }),
    ).rejects.toThrow('Only one read-only statement')
  })

  test('a write that tries to control the transaction', async () => {
    await expect(runAgentQuery({ connectionId: 'no-such-connection', sql: 'commit', access: 'write' })).rejects.toThrow(
      'Transaction statements',
    )
  })

  test('a write that uses COPY to stdout', async () => {
    await expect(
      runAgentQuery({ connectionId: 'no-such-connection', sql: 'copy t to stdout', access: 'write' }),
    ).rejects.toThrow('COPY')
  })

  test('an empty write', async () => {
    await expect(
      runAgentQuery({ connectionId: 'no-such-connection', sql: '-- nothing', access: 'write' }),
    ).rejects.toThrow('No statement to run.')
  })
})
