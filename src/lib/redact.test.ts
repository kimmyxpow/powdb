import { describe, expect, test } from 'bun:test'
import { describeError, redactSecrets } from './redact'

describe('redactSecrets', () => {
  test('hides the password in a postgres URL and keeps host and user', () => {
    expect(redactSecrets('connect postgres://app:s3cret@db.internal:5432/app failed')).toBe(
      'connect postgres://app:***@db.internal:5432/app failed',
    )
    expect(redactSecrets('postgresql://u:p/w@x@h/db')).toBe('postgresql://u:***@h/db')
  })

  test('leaves URLs without a password alone', () => {
    expect(redactSecrets('postgres://app@db/app')).toBe('postgres://app@db/app')
    expect(redactSecrets('postgres://db:5432/app')).toBe('postgres://db:5432/app')
  })

  test('hides password settings in conninfo, env and JSON style text', () => {
    expect(redactSecrets("host=db password='a b' user=x")).toBe('host=db password=*** user=x')
    expect(redactSecrets('PGPASSWORD=hunter2 ok')).toBe('PGPASSWORD=*** ok')
    expect(redactSecrets('{"password": "hunter2", "user": "x"}')).toBe('{"password": ***, "user": "x"}')
    expect(redactSecrets('  password: hunter2')).toBe('  password: ***')
  })

  test('does not touch password_env names', () => {
    expect(redactSecrets('password_env: POWDBS_PROD_PW')).toBe('password_env: POWDBS_PROD_PW')
  })

  test('hides known secret values wherever they appear', () => {
    expect(redactSecrets('value abc123 leaked twice abc123', ['abc123'])).toBe('value *** leaked twice ***')
    expect(redactSecrets('hello', ['', undefined])).toBe('hello')
  })
})

describe('describeError', () => {
  test('returns the stack with secrets hidden, and stringifies other values', () => {
    const err = new Error('login postgres://app:s3cret@db failed')
    const text = describeError(err)
    expect(text).toContain('postgres://app:***@db')
    expect(text).not.toContain('s3cret')
    expect(describeError('password=hunter2')).toBe('password=***')
  })
})
