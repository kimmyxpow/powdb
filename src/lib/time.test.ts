import { describe, expect, test } from 'bun:test'
import { displayTemporal, parseTimestamptz, sameTimestamptz, toLocalTimestamptz } from './time'

describe('time display', () => {
  test('parses PostgreSQL timestamptz output', () => {
    expect(parseTimestamptz('2025-06-23 22:14:08.919472+00')?.ms).toBe(Date.UTC(2025, 5, 23, 22, 14, 8))
    expect(parseTimestamptz('2025-06-24 05:14:08+07')?.ms).toBe(Date.UTC(2025, 5, 23, 22, 14, 8))
    expect(parseTimestamptz('2025-06-23 17:44:08+05:30:00')?.ms).toBe(Date.UTC(2025, 5, 23, 12, 14, 8))
    expect(parseTimestamptz('infinity')).toBeNull()
    expect(parseTimestamptz('4713-01-01 00:00:00+00 BC')).toBeNull()
  })

  test('same instant in another zone is the same value', () => {
    expect(sameTimestamptz('2025-06-23 22:14:08.919472+00', '2025-06-24 05:14:08.919472+07')).toBe(true)
    expect(sameTimestamptz('2025-06-23 22:14:08.5+00', '2025-06-23 22:14:08.500000+00')).toBe(true)
    expect(sameTimestamptz('2025-06-23 22:14:08+00', '2025-06-23 22:14:09+00')).toBe(false)
  })

  test('local editing text round-trips', () => {
    const raw = '2025-06-23 22:14:08.919472+00'
    const local = toLocalTimestamptz(raw)!
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.919472[+-]\d{2}/)
    expect(sameTimestamptz(raw, local)).toBe(true)
  })

  test('fraction is hidden unless asked for', () => {
    expect(displayTemporal('2025-06-23 22:14:08.919472', 'timestamp', { timeZone: 'local', fraction: false })).toBe(
      '2025-06-23 22:14:08',
    )
    expect(displayTemporal('12:00:01.5', 'time', { timeZone: 'utc', fraction: true })).toBe('12:00:01.5')
    expect(displayTemporal('2025-06-23 22:14:08.9+00', 'timestamptz', { timeZone: 'utc', fraction: false })).toBe(
      '2025-06-23 22:14:08+00',
    )
    expect(displayTemporal('-infinity', 'timestamptz', { timeZone: 'local', fraction: false })).toBe('-infinity')
  })
})
