import { describe, expect, test } from 'bun:test'
import { explainSql, isMissingParameters, lockWaitMessage, hasParameters, unavailableReason } from './execute.server'

// Only the checks that run before any connection is opened are tested here.
const run = (sql: string) =>
  explainSql('no-such-connection', 'no-such-db', sql, { analyze: false, executionId: 'test' })

describe('explainSql input checks', () => {
  test('empty input gives an empty result', async () => {
    const out = await run('   \n ')
    expect(out.error).toBeNull()
    expect(out.plan).toBeNull()
    expect(out.results).toEqual([])
  })

  test('more than one statement is refused', async () => {
    const out = await run('select 1; select 2')
    expect(out.error).toEqual({
      message: 'Explain works on one statement at a time. Put the cursor in a statement or select it.',
      statementIndex: -1,
      from: 0,
      to: 0,
    })
  })

  test('a statement that already starts with EXPLAIN is refused', async () => {
    const out = await run('explain select 1')
    expect(out.error?.message).toBe('Remove EXPLAIN from the statement. The Explain button adds it.')
    expect(out.error?.statementIndex).toBe(0)
    expect(out.error?.to).toBe('explain select 1'.length)
  })
})

describe('unavailableReason', () => {
  const base = {
    analyze: false,
    hasParams: true,
    missingValues: false,
    serverVersionNum: null,
    code: undefined,
    cancelled: false,
  }

  test('Explain Analyze without values gives needs-values-analyze', () => {
    expect(unavailableReason({ ...base, analyze: true, missingValues: true, code: '42P02' })).toBe(
      'needs-values-analyze',
    )
  })

  test('plain Explain without values on PostgreSQL 15 or older gives needs-newer-postgres', () => {
    const input = { ...base, missingValues: true, code: '42P02' }
    expect(unavailableReason({ ...input, serverVersionNum: 150007 })).toBe('needs-newer-postgres')
    expect(unavailableReason({ ...input, serverVersionNum: 159999 })).toBe('needs-newer-postgres')
    expect(unavailableReason({ ...input, serverVersionNum: null })).toBe('needs-newer-postgres')
  })

  test('the extended protocol bind error counts as missing values too', () => {
    expect(
      unavailableReason({
        ...base,
        analyze: true,
        missingValues: isMissingParameters(
          '08P01',
          'bind message supplies 0 parameters, but prepared statement "" requires 10',
        ),
      }),
    ).toBe('needs-values-analyze')
  })

  test('any other failure of a statement with parameters gives needs-values', () => {
    expect(unavailableReason({ ...base, code: '42P18' })).toBe('needs-values')
    expect(unavailableReason({ ...base, analyze: true, code: '42P18' })).toBe('needs-values')
    expect(unavailableReason({ ...base, serverVersionNum: 170002, code: '42804' })).toBe('needs-values')
  })

  test('a cancel stays an error', () => {
    expect(unavailableReason({ ...base, cancelled: true, code: '57014' })).toBeNull()
    expect(unavailableReason({ ...base, cancelled: true, missingValues: true, code: '42P02' })).toBeNull()
  })

  test('a lock wait stays an error', () => {
    expect(unavailableReason({ ...base, code: '55P03' })).toBeNull()
    expect(unavailableReason({ ...base, analyze: true, code: '55P03' })).toBeNull()
  })

  test('a statement without parameters stays an error', () => {
    expect(unavailableReason({ ...base, hasParams: false, code: '42601' })).toBeNull()
    expect(
      unavailableReason({ ...base, hasParams: false, analyze: true, missingValues: true, code: '42P02' }),
    ).toBeNull()
  })
})

describe('lockWaitMessage', () => {
  test('lock_not_available (55P03) gets the plain message about a locked table', () => {
    expect(lockWaitMessage('55P03')).toBe(
      'A table in this query is locked by another session (for example by ALTER TABLE). Try again in a moment.',
    )
  })

  test('other errors keep the message from Postgres', () => {
    expect(lockWaitMessage('42601')).toBeNull()
    expect(lockWaitMessage('57014')).toBeNull()
    expect(lockWaitMessage(undefined)).toBeNull()
  })
})

describe('isMissingParameters', () => {
  test('the simple protocol error about an undefined parameter', () => {
    expect(isMissingParameters('42P02', 'there is no parameter $1')).toBe(true)
  })

  test('the extended protocol error about missing bind values', () => {
    expect(
      isMissingParameters('08P01', 'bind message supplies 0 parameters, but prepared statement "" requires 10'),
    ).toBe(true)
  })

  test('other errors', () => {
    expect(isMissingParameters('08P01', 'some other protocol error')).toBe(false)
    expect(isMissingParameters('42601', 'syntax error at or near "selec"')).toBe(false)
    expect(isMissingParameters(undefined, 'bind message supplies 0 parameters')).toBe(false)
  })
})

describe('hasParameters', () => {
  test('finds $1, $2, ... in the query', () => {
    expect(hasParameters('select * from t where id = $1')).toBe(true)
    expect(hasParameters('select generate_series($3, $4)')).toBe(true)
  })

  test('ignores text inside quotes and dollar quotes', () => {
    expect(hasParameters("select '$1' as price")).toBe(false)
    expect(hasParameters('select 1 as "$2"')).toBe(false)
    expect(hasParameters('select $$costs $5$$')).toBe(false)
    expect(hasParameters('select $tag$ $1 $tag$')).toBe(false)
  })

  test('a query without parameters', () => {
    expect(hasParameters('select * from orders where id = 1')).toBe(false)
  })
})
