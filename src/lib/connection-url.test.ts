import { describe, expect, test } from 'bun:test'
import { buildConnectionUrl, looksLikeUrl, parseConnectionUrl } from './connection-url'
import type { SslMode } from './types'

describe('looksLikeUrl', () => {
  test.each([
    ['postgres://h/db', true],
    ['postgresql://h/db', true],
    ['POSTGRES://h/db', true],
    ['  postgresql://h/db  ', true],
    ['postgres:/h/db', false],
    ['postgres:', false],
    ['mysql://h/db', false],
    ['localhost:5432', false],
    ['', false],
  ])('%p -> %p', (value, expected) => {
    expect(looksLikeUrl(value)).toBe(expected)
  })
})

describe('parseConnectionUrl', () => {
  test('a full postgres:// URL gives every field', () => {
    expect(parseConnectionUrl('postgres://ann:s3cret@db.internal:6543/orders')).toEqual({
      host: 'db.internal',
      port: 6543,
      database: 'orders',
      user: 'ann',
      password: 's3cret',
      ssl: 'disable',
    })
  })

  test('postgresql:// is read the same way as postgres://', () => {
    expect(parseConnectionUrl('postgresql://ann:s3cret@db.internal:6543/orders')).toEqual(
      parseConnectionUrl('postgres://ann:s3cret@db.internal:6543/orders'),
    )
  })

  test('a missing port, database, user and password take their defaults', () => {
    expect(parseConnectionUrl('postgres://db.internal')).toEqual({
      host: 'db.internal',
      port: 5432,
      database: 'postgres',
      user: 'postgres',
      password: '',
      ssl: 'disable',
    })
  })

  test('percent-encoded user and password are decoded', () => {
    const parsed = parseConnectionUrl('postgres://us%40er:p%40ss%3Aword%2F%25@h/db')
    expect(parsed?.user).toBe('us@er')
    expect(parsed?.password).toBe('p@ss:word/%')
  })

  test('a raw @ in the password is taken from after the last @', () => {
    const parsed = parseConnectionUrl('postgres://user:p@ss@h/db')
    expect(parsed?.user).toBe('user')
    expect(parsed?.password).toBe('p@ss')
    expect(parsed?.host).toBe('h')
  })

  test('a raw : in the password is kept', () => {
    expect(parseConnectionUrl('postgres://user:pa:ss@h/db')?.password).toBe('pa:ss')
  })

  test('an IPv6 host in brackets is read without the brackets', () => {
    expect(parseConnectionUrl('postgres://user@[::1]:5433/db')).toMatchObject({ host: '::1', port: 5433 })
    expect(parseConnectionUrl('postgres://[2001:db8::1]/db')).toMatchObject({ host: '2001:db8::1', port: 5432 })
  })

  test.each<[string, SslMode]>([
    ['require', 'require'],
    ['REQUIRE', 'require'],
    ['prefer', 'require'],
    ['verify-ca', 'verify-full'],
    ['verify-full', 'verify-full'],
    ['disable', 'disable'],
  ])('sslmode=%s gives ssl %s', (sslmode, ssl) => {
    expect(parseConnectionUrl(`postgres://h/db?sslmode=${sslmode}`)?.ssl).toBe(ssl)
  })

  test.each<[string, SslMode]>([
    ['true', 'require'],
    ['1', 'require'],
    ['false', 'disable'],
    ['0', 'disable'],
  ])('ssl=%s gives ssl %s', (flag, ssl) => {
    expect(parseConnectionUrl(`postgres://h/db?ssl=${flag}`)?.ssl).toBe(ssl)
  })

  test('surrounding whitespace is ignored', () => {
    expect(parseConnectionUrl('   postgres://ann@h:5432/db  ')).toMatchObject({
      host: 'h',
      user: 'ann',
      database: 'db',
    })
  })

  test.each([
    ['not a URL', 'localhost:5432'],
    ['another scheme', 'mysql://ann@h/db'],
    ['an empty string', ''],
    ['a port that is not a number', 'postgres://h:abc/db'],
    ['a port out of range', 'postgres://h:99999/db'],
    ['a password with no @ before the address', 'postgres://user:pass/db'],
  ])('%s gives null', (_, value) => {
    expect(parseConnectionUrl(value)).toBeNull()
  })

  test('a pasted password with # gives every field (the URL that failed before)', () => {
    expect(parseConnectionUrl('postgres://postgres:451AdminDev#@192.168.42.90:5432/app_ac_scoring_rep')).toEqual({
      host: '192.168.42.90',
      port: 5432,
      database: 'app_ac_scoring_rep',
      user: 'postgres',
      password: '451AdminDev#',
      ssl: 'disable',
    })
  })

  test('a password with @, /, ?, : and # together is read whole', () => {
    const parsed = parseConnectionUrl('postgresql://ann:p@ss/w?rd:#x@db.internal:6543/orders?sslmode=require')
    expect(parsed).toEqual({
      host: 'db.internal',
      port: 6543,
      database: 'orders',
      user: 'ann',
      password: 'p@ss/w?rd:#x',
      ssl: 'require',
    })
  })

  test('an already percent-encoded password is decoded once', () => {
    expect(parseConnectionUrl('postgres://ann:p%40ss@h/db')?.password).toBe('p@ss')
  })

  test('a bare % in the password is kept as typed', () => {
    expect(parseConnectionUrl('postgres://user:100%@h/db')).toMatchObject({ host: 'h', user: 'user', password: '100%' })
    expect(parseConnectionUrl('postgres://user:100%#x@h/db')?.password).toBe('100%#x')
  })

  test('a password with the special characters survives a percent-encoded round trip', () => {
    const password = 'a@b/c?d:e#f'
    const url = `postgresql://ann:${encodeURIComponent(password)}@db.internal:5432/orders`
    expect(parseConnectionUrl(url)).toMatchObject({ host: 'db.internal', user: 'ann', database: 'orders', password })
  })

  test('a password put into a built URL keeps the built host, port, database and ssl', () => {
    const built = buildConnectionUrl({
      host: '2001:db8::1',
      port: 5433,
      database: 'orders',
      user: 'ann',
      ssl: 'verify-full',
    })
    const withPassword = built.replace('postgresql://ann@', 'postgresql://ann:p#@/?:@')
    expect(parseConnectionUrl(withPassword)).toEqual({
      host: '2001:db8::1',
      port: 5433,
      database: 'orders',
      user: 'ann',
      password: 'p#@/?:',
      ssl: 'verify-full',
    })
  })

  test('IPv6 hosts work with a password that has special characters', () => {
    expect(parseConnectionUrl('postgres://ann:x#y@[::1]:5433/db')).toMatchObject({
      host: '::1',
      port: 5433,
      user: 'ann',
      password: 'x#y',
    })
  })

  test('sslmode and ssl still work after a password with special characters', () => {
    expect(parseConnectionUrl('postgres://ann:x#y@h/db?sslmode=verify-ca')?.ssl).toBe('verify-full')
    expect(parseConnectionUrl('postgres://ann:x#y@h/db?ssl=true')?.ssl).toBe('require')
    expect(parseConnectionUrl('postgres://ann:x#y@h/db?sslmode=disable')?.ssl).toBe('disable')
  })

  test('no credentials at all: user defaults to postgres and password is empty', () => {
    expect(parseConnectionUrl('postgres://h:6000/db?sslmode=require')).toEqual({
      host: 'h',
      port: 6000,
      database: 'db',
      user: 'postgres',
      password: '',
      ssl: 'require',
    })
  })
})

describe('buildConnectionUrl', () => {
  const base = { host: 'db.internal', port: 5432, database: 'orders', user: 'ann', ssl: 'disable' as SslMode }

  test('a plain URL names the user, host, port and database, with no password', () => {
    expect(buildConnectionUrl(base)).toBe('postgresql://ann@db.internal:5432/orders')
  })

  test('ssl other than disable is written as sslmode', () => {
    expect(buildConnectionUrl({ ...base, ssl: 'require' })).toBe(
      'postgresql://ann@db.internal:5432/orders?sslmode=require',
    )
    expect(buildConnectionUrl({ ...base, ssl: 'verify-full' })).toBe(
      'postgresql://ann@db.internal:5432/orders?sslmode=verify-full',
    )
  })

  test('an IPv6 host is written in brackets', () => {
    expect(buildConnectionUrl({ ...base, host: '2001:db8::1' })).toBe('postgresql://ann@[2001:db8::1]:5432/orders')
  })

  test('a password on the input is never written into the URL', () => {
    const withSecret = { ...base, password: 'hunter2' }
    const url = buildConnectionUrl(withSecret)
    expect(url).toBe('postgresql://ann@db.internal:5432/orders')
    expect(url).not.toContain('hunter2')
  })

  test.each<[string, string]>([
    ['ann', 'plain'],
    ['we@ird:us/er%x y', 'special'],
    ['a+b&c=d', 'symbols'],
  ])('user %p round-trips through parse', (user) => {
    expect(parseConnectionUrl(buildConnectionUrl({ ...base, user }))?.user).toBe(user)
  })

  test.each<[string]>([['orders'], ['my db/x?y#z'], ['100%']])('database %p round-trips through parse', (database) => {
    expect(parseConnectionUrl(buildConnectionUrl({ ...base, database }))?.database).toBe(database)
  })

  test.each<[string, SslMode]>([
    ['disable', 'disable'],
    ['require', 'require'],
    ['verify-full', 'verify-full'],
  ])('ssl %s round-trips through parse', (_, ssl) => {
    expect(parseConnectionUrl(buildConnectionUrl({ ...base, ssl }))?.ssl).toBe(ssl)
  })

  test('host, port and database round-trip through parse, IPv6 included', () => {
    for (const host of ['db.internal', '10.0.0.7', '2001:db8::1']) {
      const parsed = parseConnectionUrl(buildConnectionUrl({ ...base, host, port: 6543 }))
      expect(parsed).toMatchObject({ host, port: 6543, database: 'orders', user: 'ann', password: '' })
    }
  })
})
