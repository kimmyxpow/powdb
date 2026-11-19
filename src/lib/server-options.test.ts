import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_MAX_IMPORT_MB,
  DEFAULT_MAX_RESTORE_MB,
  IDLE_TIMEOUT_SECONDS,
  isLongRunningPath,
  megabytesFrom,
  requestBodyLimitBytes,
} from './server-options'

const MB = 1024 * 1024

describe('megabytesFrom', () => {
  test('unset, empty, non-numeric or not positive values give the fallback', () => {
    for (const raw of [undefined, '', '   ', 'abc', '0', '-5', 'NaN', 'Infinity']) {
      expect(megabytesFrom(raw, 7)).toBe(7)
    }
  })

  test('a positive number is used, fractions included', () => {
    expect(megabytesFrom('512', 7)).toBe(512)
    expect(megabytesFrom(' 12.5 ', 7)).toBe(12.5)
  })
})

describe('requestBodyLimitBytes', () => {
  test('defaults to the restore limit, which is the larger of the two defaults', () => {
    expect(DEFAULT_MAX_IMPORT_MB).toBe(200)
    expect(DEFAULT_MAX_RESTORE_MB).toBe(2048)
    expect(requestBodyLimitBytes({})).toBe(2048 * MB)
  })

  test('follows a larger restore limit', () => {
    expect(requestBodyLimitBytes({ POWDBS_MAX_RESTORE_MB: '4096' })).toBe(4096 * MB)
  })

  test('follows a larger import limit', () => {
    expect(requestBodyLimitBytes({ POWDBS_MAX_IMPORT_MB: '5000', POWDBS_MAX_RESTORE_MB: '512' })).toBe(5000 * MB)
  })

  test('a smaller restore limit does not shrink the limit below the import default', () => {
    expect(requestBodyLimitBytes({ POWDBS_MAX_RESTORE_MB: '64' })).toBe(200 * MB)
  })

  test('invalid values fall back to the defaults', () => {
    expect(requestBodyLimitBytes({ POWDBS_MAX_RESTORE_MB: 'lots', POWDBS_MAX_IMPORT_MB: '-1' })).toBe(2048 * MB)
  })
})

describe('isLongRunningPath', () => {
  test('uploads and exports get no idle timeout', () => {
    for (const p of ['/api/import/csv', '/api/import/restore', '/api/export/database', '/api/export/table']) {
      expect(isLongRunningPath(p)).toBe(true)
    }
    expect(isLongRunningPath('/api/export/database/status')).toBe(true)
  })

  test('other requests keep the idle timeout', () => {
    for (const p of ['/api/auth/state', '/api/v1/connections', '/mcp', '/login', '/api/importer', '/api/import']) {
      expect(isLongRunningPath(p)).toBe(false)
    }
  })

  test('Bun caps idleTimeout at 255 seconds', () => {
    expect(IDLE_TIMEOUT_SECONDS).toBe(255)
  })
})
