import { describe, expect, test } from 'bun:test'
import { parsePgArray, toPgArray } from './pg-array'
import { validateValue } from './validate'

const ok = (v: Parameters<typeof validateValue>[0], spec: Parameters<typeof validateValue>[1]) =>
  expect(validateValue(v, spec)).toBeNull()
const bad = (v: Parameters<typeof validateValue>[0], spec: Parameters<typeof validateValue>[1], message: string) =>
  expect(validateValue(v, spec)).toBe(message)

describe('validateValue', () => {
  test('integers and ranges', () => {
    ok('32767', { kind: 'number', typeName: 'int2' })
    bad('32768', { kind: 'number', typeName: 'int2' }, 'Out of range for int2 (-32768 to 32767)')
    bad('1.5', { kind: 'number', typeName: 'int4' }, 'Must be a whole number')
    ok('9223372036854775807', { kind: 'number', typeName: 'int8' })
  })
  test('numeric precision', () => {
    ok('12345678.99', { kind: 'number', typeName: 'numeric', fullType: 'numeric(10,2)' })
    bad(
      '123456789.5',
      { kind: 'number', typeName: 'numeric', fullType: 'numeric(10,2)' },
      'Too large for numeric(10,2): at most 8 digits before the decimal point',
    )
    bad('12,5', { kind: 'number', typeName: 'numeric' }, 'Must be a number, e.g. 12.5')
    ok('1e3', { kind: 'number', typeName: 'float8' })
  })
  test('dates and times', () => {
    ok('2024-02-29', { kind: 'date', typeName: 'date' })
    bad('2023-02-29', { kind: 'date', typeName: 'date' }, 'This date does not exist')
    ok('2026-11-04 00:09:43.638337+00', { kind: 'timestamp', typeName: 'timestamptz' })
    ok('2026-11-04T00:09:43Z', { kind: 'timestamp', typeName: 'timestamptz' })
    ok('now', { kind: 'timestamp', typeName: 'timestamptz' })
    bad('2026-13-01 10:00', { kind: 'timestamp', typeName: 'timestamp' }, 'This date does not exist')
    bad(
      'yesterday-ish',
      { kind: 'timestamp', typeName: 'timestamp' },
      'Not a valid date and time. Use YYYY-MM-DD HH:MM:SS',
    )
    ok('23:59:59', { kind: 'time', typeName: 'time' })
    bad('25:00', { kind: 'time', typeName: 'time' }, 'This time does not exist')
    ok('2 days 3 hours', { kind: 'interval', typeName: 'interval' })
    ok('01:30:00', { kind: 'interval', typeName: 'interval' })
    ok('P1DT2H', { kind: 'interval', typeName: 'interval' })
    bad('soon', { kind: 'interval', typeName: 'interval' }, 'Not a valid interval, e.g. 2 days, 01:30:00 or P1DT2H')
  })
  test('other types', () => {
    ok('123e4567-e89b-12d3-a456-426614174000', { kind: 'uuid', typeName: 'uuid' })
    bad('123', { kind: 'uuid', typeName: 'uuid' }, 'Not a valid UUID, e.g. 123e4567-e89b-12d3-a456-426614174000')
    // the parser's own wording differs between runtimes, so only the prefix is fixed
    expect(validateValue('{"a":}', { kind: 'json', typeName: 'jsonb' })).toStartWith('Invalid JSON: ')
    ok('10.0.0.1', { kind: 'network', typeName: 'inet' })
    bad('10.0.0.300', { kind: 'network', typeName: 'inet' }, 'Each part of an IPv4 address is 0–255')
    ok('::1', { kind: 'network', typeName: 'inet' })
    ok('5874897-12-31', { kind: 'date', typeName: 'date' })
    ok('294276-12-31 23:59:59', { kind: 'timestamp', typeName: 'timestamp' })
    bad('2023-02-29', { kind: 'date', typeName: 'date' }, 'This date does not exist')
    ok('08:00:2b:01:02:03', { kind: 'network', typeName: 'macaddr' })
    ok('0800.2b01.0203', { kind: 'network', typeName: 'macaddr' })
    bad('10.0.0.1', { kind: 'network', typeName: 'macaddr' }, 'Not a valid MAC address, e.g. 08:00:2b:01:02:03')
    bad(
      'abcdef',
      { kind: 'text', typeName: 'varchar', fullType: 'character varying(5)' },
      'Too long: 6 characters, the limit is 5',
    )
    bad('x', { kind: 'enum', typeName: 'order_status', enumValues: ['paid'] }, 'Must be one of: paid')
  })
  test('arrays check every item', () => {
    ok('{1,2,3}', { kind: 'array', typeName: 'int4[]' })
    bad('{1,x,3}', { kind: 'array', typeName: 'int4[]' }, 'Item 2: Must be a whole number')
    ok('{"a b",NULL}', { kind: 'array', typeName: 'text[]' })
    bad('1,2', { kind: 'array', typeName: 'int4[]' }, 'Not a valid list, e.g. {a,b,c}')
  })
  test('required / null', () => {
    expect(validateValue(undefined, { kind: 'text', typeName: 'text', nullable: false }, { isNew: true })).toBe(
      'Required',
    )
    ok(undefined, { kind: 'text', typeName: 'text', nullable: false, hasDefault: true })
    bad(null, { kind: 'text', typeName: 'text', nullable: false }, 'Cannot be NULL')
  })
})

test('array literal round trip', () => {
  const items = ['plain', 'with space', 'quote " here', 'back\\slash', null, 'NULL', '']
  expect(parsePgArray(toPgArray(items))).toEqual(items)
})

test('local time hint for values in another zone', async () => {
  const { localTimeHint } = await import('../components/grid/value-editors')
  const hint = localTimeHint('2025-04-21 20:28:34.12991+00', 'timestamp', 'timestamptz')
  // in a UTC test environment the hint is skipped (same zone); otherwise it names the local time
  expect(hint === null || hint.startsWith('Your time: ')).toBe(true)
  expect(localTimeHint('2025-04-21 20:28:34', 'timestamp', 'timestamp')).toBeNull()
})
