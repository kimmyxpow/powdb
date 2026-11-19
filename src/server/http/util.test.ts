import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { s } from '@/lib/schema'
import { RateLimitError, SESSION_COOKIE } from '@/server/auth.server'
import { MANAGED_ERROR } from '@/server/store.server'
import {
  errorResponse,
  errorToResponse,
  guardMutation,
  guardOrigin,
  HttpError,
  jsonResponse,
  MAX_BODY_BYTES,
  parseBody,
  queryParam,
  readCookie,
  readText,
  sessionCookieHeader,
} from './util.server'

/** A stand-in for a Request: only the headers and the body stream are used by readText. */
function fakeRequest(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  const state = { pulled: 0, cancelled: false }
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const next = chunks[state.pulled]
        state.pulled++
        if (next) controller.enqueue(next)
        else controller.close()
      },
      cancel() {
        state.cancelled = true
      },
    },
    { highWaterMark: 0 },
  )
  return { request: { headers: new Headers(headers), body } as unknown as Request, state }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (err) {
    return err
  }
  throw new Error('expected a rejection')
}

describe('readText', () => {
  test('joins the chunks and decodes UTF-8 split across chunk boundaries', async () => {
    const bytes = new TextEncoder().encode('héllo wörld ✓')
    const { request } = fakeRequest([bytes.slice(0, 3), bytes.slice(3, 9), bytes.slice(9)])
    expect(await readText(request)).toBe('héllo wörld ✓')
  })

  test('an absent body is an empty string', async () => {
    const request = { headers: new Headers(), body: null } as unknown as Request
    expect(await readText(request)).toBe('')
  })

  test('a body of exactly the limit is accepted', async () => {
    const chunk = new Uint8Array(MAX_BODY_BYTES / 4).fill(97)
    const { request } = fakeRequest([chunk, chunk, chunk, chunk])
    expect((await readText(request)).length).toBe(MAX_BODY_BYTES)
  })

  test('stops reading as soon as the limit is passed, with the same error as before', async () => {
    const chunk = new Uint8Array(256 * 1024).fill(120)
    const { request, state } = fakeRequest(Array.from({ length: 100 }, () => chunk))
    const err = await rejection(readText(request))
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(400)
    expect((err as HttpError).code).toBe('body_too_large')
    expect((err as HttpError).message).toBe('The request body is larger than 1 MB.')
    expect(state.pulled).toBeLessThanOrEqual(5)
    expect(state.cancelled).toBe(true)
  })

  test('a Content-Length over the limit is refused before the body is read', async () => {
    const { request, state } = fakeRequest([new Uint8Array(10)], {
      'content-length': String(MAX_BODY_BYTES + 1),
    })
    const err = await rejection(readText(request))
    expect((err as HttpError).code).toBe('body_too_large')
    expect(state.pulled).toBe(0)
  })

  test('a Content-Length within the limit still reads the body', async () => {
    const { request } = fakeRequest([new TextEncoder().encode('{"a":1}')], { 'content-length': '7' })
    expect(await readText(request)).toBe('{"a":1}')
  })
})

function keepEnv(name: string) {
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env[name]
    delete process.env[name]
  })
  afterEach(() => {
    if (saved === undefined) delete process.env[name]
    else process.env[name] = saved
  })
}

describe('HttpError', () => {
  test('carries the status, code, message and headers', () => {
    const err = new HttpError(418, 'teapot', 'Short and stout.', { 'X-Test': '1' })
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(HttpError)
    expect(err.name).toBe('HttpError')
    expect(err.status).toBe(418)
    expect(err.code).toBe('teapot')
    expect(err.message).toBe('Short and stout.')
    expect(err.headers).toEqual({ 'X-Test': '1' })
  })

  test('headers default to an empty object', () => {
    expect(new HttpError(404, 'not_found', 'Missing.').headers).toEqual({})
  })
})

describe('jsonResponse', () => {
  test('defaults to status 200 with a JSON body and content type', async () => {
    const res = jsonResponse({ ok: true, items: [1, 2] })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    expect(await res.json()).toEqual({ ok: true, items: [1, 2] })
  })

  test('takes a status and extra headers', async () => {
    const res = jsonResponse({ id: 7 }, 201, { Location: '/api/things/7', 'Cache-Control': 'no-store' })
    expect(res.status).toBe(201)
    expect(res.headers.get('location')).toBe('/api/things/7')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    expect(await res.json()).toEqual({ id: 7 })
  })

  test('sends an explicit Content-Length equal to the UTF-8 byte count', () => {
    const res = jsonResponse({ name: 'é✓' })
    expect(res.headers.get('content-length')).toBe(String(new TextEncoder().encode('{"name":"é✓"}').byteLength))
  })
})

describe('errorResponse', () => {
  test('is a JSON body of { error: { code, message } } with the status', async () => {
    const res = errorResponse(422, 'bad_thing', 'The thing is bad.')
    expect(res.status).toBe(422)
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    expect(await res.json()).toEqual({ error: { code: 'bad_thing', message: 'The thing is bad.' } })
  })

  test('passes extra headers through', () => {
    const res = errorResponse(401, 'unauthorized', 'Sign in.', { 'WWW-Authenticate': 'Bearer' })
    expect(res.headers.get('www-authenticate')).toBe('Bearer')
  })
})

describe('errorToResponse', () => {
  let consoleError: ReturnType<typeof spyOn>
  beforeEach(() => {
    consoleError = spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    consoleError.mockRestore()
  })

  test('an HttpError keeps its status, code, message and headers', async () => {
    const res = errorToResponse(new HttpError(403, 'cross_origin', 'Nope.', { 'X-Why': 'origin' }))
    expect(res.status).toBe(403)
    expect(res.headers.get('x-why')).toBe('origin')
    expect(await res.json()).toEqual({ error: { code: 'cross_origin', message: 'Nope.' } })
    expect(consoleError).not.toHaveBeenCalled()
  })

  test('a RateLimitError is a 429 with Retry-After in seconds', async () => {
    const res = errorToResponse(new RateLimitError(90))
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('90')
    expect(await res.json()).toEqual({
      error: { code: 'rate_limited', message: 'Too many failed sign-in attempts. Try again later.' },
    })
  })

  test('the managed-config error is a 409 with code "managed"', async () => {
    const res = errorToResponse(new Error(MANAGED_ERROR))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: { code: 'managed', message: MANAGED_ERROR } })
    expect(consoleError).not.toHaveBeenCalled()
  })

  test('an unknown Error is a 500 "internal" and is logged; the code sends the error message through', async () => {
    const res = errorToResponse(new Error('relation "secrets" does not exist'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: { code: 'internal', message: 'relation "secrets" does not exist' },
    })
    expect(consoleError).toHaveBeenCalledTimes(1)
  })

  test('a thrown non-Error is a 500 with the generic message', async () => {
    const res = errorToResponse('a string was thrown')
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: { code: 'internal', message: 'Unexpected error.' } })
    expect(consoleError).toHaveBeenCalledTimes(1)
  })
})

describe('parseBody', () => {
  const person = s.object({
    name: s.string().min(1),
    age: s.number().int(),
  })

  function post(body: string, headers: Record<string, string> = {}): Request {
    return new Request('http://localhost:3335/api/people', { method: 'POST', body, headers })
  }

  test('a valid JSON body is returned as the parsed value', async () => {
    expect(await parseBody(post(JSON.stringify({ name: 'Ada', age: 36 })), person)).toEqual({ name: 'Ada', age: 36 })
  })

  test('an empty body is treated as an empty object, so the schema decides', async () => {
    const optional = s.object({ note: s.string().optional() })
    expect(await parseBody(post(''), optional)).toEqual({})
    await expect(parseBody(post(''), person)).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    })
  })

  test('a body that is not JSON is a 400 invalid_json', async () => {
    const err = await rejection(parseBody(post('{"name": '), person))
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(400)
    expect((err as HttpError).code).toBe('invalid_json')
    expect((err as HttpError).message).toBe('The request body is not valid JSON.')
  })

  test('a schema failure names the field path and the first problem', async () => {
    const err = await rejection(parseBody(post(JSON.stringify({ name: 5, age: 1 })), person))
    expect((err as HttpError).status).toBe(400)
    expect((err as HttpError).code).toBe('invalid_request')
    expect((err as HttpError).message).toBe('name: Invalid input: expected string, received number')
  })

  test('only the first problem is reported when several fields are wrong', async () => {
    const err = await rejection(parseBody(post(JSON.stringify({ name: '', age: 1.5 })), person))
    expect((err as HttpError).message).toBe('name: Too small: expected string to have >=1 characters')
  })

  test('a nested field path is joined with dots, and array indexes appear as numbers', async () => {
    const nested = s.object({ conn: s.object({ port: s.number() }), tags: s.array(s.string()) })
    const err = await rejection(parseBody(post(JSON.stringify({ conn: { port: 'x' }, tags: [] })), nested))
    expect((err as HttpError).message).toBe('conn.port: Invalid input: expected number, received string')

    const list = s.object({ tags: s.array(s.string()) })
    const err2 = await rejection(parseBody(post(JSON.stringify({ tags: ['a', 2] })), list))
    expect((err2 as HttpError).message).toBe('tags.1: Invalid input: expected string, received number')
  })

  test('a failure at the top level has no path prefix', async () => {
    const err = await rejection(parseBody(post('[1,2]'), person))
    expect((err as HttpError).message).toBe('Invalid input: expected object, received array')
  })

  test('a body over the 1 MB limit is a 400 body_too_large, before any parsing', async () => {
    const big = 'a'.repeat(MAX_BODY_BYTES + 1)
    const err = await rejection(parseBody(post(big), person))
    expect((err as HttpError).status).toBe(400)
    expect((err as HttpError).code).toBe('body_too_large')
  })
})

describe('queryParam', () => {
  const req = (search: string) => new Request(`http://localhost:3335/api/rows${search}`)

  test('returns the value of a named parameter', () => {
    expect(queryParam(req('?table=users&limit=20'), 'table')).toBe('users')
    expect(queryParam(req('?table=users&limit=20'), 'limit')).toBe('20')
  })

  test('a missing parameter is undefined', () => {
    expect(queryParam(req('?table=users'), 'schema')).toBeUndefined()
    expect(queryParam(req(''), 'table')).toBeUndefined()
  })

  test('an empty or whitespace-only value is undefined', () => {
    expect(queryParam(req('?table='), 'table')).toBeUndefined()
    expect(queryParam(req('?table=%20%20'), 'table')).toBeUndefined()
  })

  test('the value is percent-decoded and trimmed', () => {
    expect(queryParam(req('?name=%20%20public%20schema%20'), 'name')).toBe('public schema')
    expect(queryParam(req('?q=a%2Bb'), 'q')).toBe('a+b')
  })

  test('the first occurrence wins when a parameter repeats', () => {
    expect(queryParam(req('?id=1&id=2'), 'id')).toBe('1')
  })
})

describe('readCookie', () => {
  const withCookie = (cookie: string | null) =>
    new Request('http://localhost:3335/', cookie === null ? {} : { headers: { cookie } })

  test('finds one cookie among several, ignoring spacing around the separators', () => {
    const request = withCookie('theme=dark;  powdb_session=abc123 ;lang=id')
    expect(readCookie(request, 'theme')).toBe('dark')
    expect(readCookie(request, 'powdb_session')).toBe('abc123')
    expect(readCookie(request, 'lang')).toBe('id')
  })

  test('a name must match exactly, not as a prefix or suffix', () => {
    const request = withCookie('powdb_session_old=stale; xpowdb_session=other')
    expect(readCookie(request, 'powdb_session')).toBeNull()
  })

  test('a quoted value keeps its quotes, because the code does not unquote', () => {
    expect(readCookie(withCookie('name="Ada Lovelace"'), 'name')).toBe('"Ada Lovelace"')
  })

  test('a value that itself contains "=" is returned whole', () => {
    expect(readCookie(withCookie('token=YWJj==; other=1'), 'token')).toBe('YWJj==')
  })

  test('a missing cookie, or no Cookie header at all, is null', () => {
    expect(readCookie(withCookie('theme=dark'), SESSION_COOKIE)).toBeNull()
    expect(readCookie(withCookie(null), SESSION_COOKIE)).toBeNull()
  })

  test('a piece without "=" is skipped', () => {
    expect(readCookie(withCookie('flag; powdb_session=xyz'), 'powdb_session')).toBe('xyz')
    expect(readCookie(withCookie('flag'), 'flag')).toBeNull()
  })

  test('an empty value is returned as an empty string, not null', () => {
    expect(readCookie(withCookie('powdb_session='), SESSION_COOKIE)).toBe('')
  })
})

describe('sessionCookieHeader', () => {
  keepEnv('POWDB_SECURE_COOKIES')
  const http = new Request('http://localhost:3335/api/auth/login', { method: 'POST' })
  const https = new Request('https://powdb.example.test/api/auth/login', { method: 'POST' })

  test('the session cookie is HttpOnly, SameSite=Lax, Path=/ and has the given Max-Age', () => {
    expect(sessionCookieHeader(http, 'powdb_abc', 3600)).toBe(
      'powdb_session=powdb_abc; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600',
    )
  })

  test('sign-out clears the cookie with an empty value and Max-Age=0', () => {
    expect(sessionCookieHeader(http, '', 0)).toBe('powdb_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0')
  })

  test('the session cookie name is the SESSION_COOKIE constant', () => {
    expect(SESSION_COOKIE).toBe('powdb_session')
    expect(sessionCookieHeader(http, 't', 1).startsWith('powdb_session=t;')).toBe(true)
  })

  test('auto (the default): Secure is set over https', () => {
    expect(sessionCookieHeader(https, 't', 60)).toBe(
      'powdb_session=t; HttpOnly; SameSite=Lax; Path=/; Max-Age=60; Secure',
    )
  })

  test('auto: Secure is set when X-Forwarded-Proto says https, using the first hop', () => {
    const proxied = new Request('http://localhost:3335/', { headers: { 'x-forwarded-proto': 'https, http' } })
    expect(sessionCookieHeader(proxied, 't', 60).endsWith('; Secure')).toBe(true)
    const plain = new Request('http://localhost:3335/', { headers: { 'x-forwarded-proto': 'http' } })
    expect(sessionCookieHeader(plain, 't', 60).endsWith('; Secure')).toBe(false)
  })

  test('POWDB_SECURE_COOKIES=true forces Secure over plain http (case and spaces ignored)', () => {
    process.env.POWDB_SECURE_COOKIES = '  TRUE '
    expect(sessionCookieHeader(http, 't', 60).endsWith('; Secure')).toBe(true)
    expect(sessionCookieHeader(http, '', 0).endsWith('; Max-Age=0; Secure')).toBe(true)
  })

  test('POWDB_SECURE_COOKIES=false forces Secure off even over https', () => {
    process.env.POWDB_SECURE_COOKIES = 'false'
    expect(sessionCookieHeader(https, 't', 60)).toBe('powdb_session=t; HttpOnly; SameSite=Lax; Path=/; Max-Age=60')
  })

  test('any other POWDB_SECURE_COOKIES value behaves as auto', () => {
    process.env.POWDB_SECURE_COOKIES = 'yes'
    expect(sessionCookieHeader(https, 't', 60).endsWith('; Secure')).toBe(true)
    expect(sessionCookieHeader(http, 't', 60).endsWith('; Secure')).toBe(false)
  })

  test('the logout cookie clears the session: empty value, Max-Age=0, same attributes', () => {
    expect(sessionCookieHeader(http, '', 0)).toBe('powdb_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0')
    expect(sessionCookieHeader(https, '', 0)).toBe('powdb_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure')
  })
})

describe('guardOrigin', () => {
  const at = (headers: Record<string, string>) =>
    new Request('http://localhost:3335/api/x', { method: 'POST', headers })

  test('no Origin header is allowed (same-site tools and curl send none)', () => {
    expect(() => guardOrigin(at({}))).not.toThrow()
  })

  test('an Origin that names the Host is allowed, including on a non-default port', () => {
    expect(() => guardOrigin(at({ host: 'localhost:3335', origin: 'http://localhost:3335' }))).not.toThrow()
  })

  test('the host comparison ignores case', () => {
    expect(() => guardOrigin(at({ host: 'PowDB.Example.test', origin: 'https://powdb.example.test' }))).not.toThrow()
  })

  test('the scheme is not compared, only the host', () => {
    expect(() => guardOrigin(at({ host: 'localhost:3335', origin: 'https://localhost:3335' }))).not.toThrow()
  })

  test('a different host is a 403 cross_origin', async () => {
    const err = await rejectionSync(() => guardOrigin(at({ host: 'localhost:3335', origin: 'https://evil.test' })))
    expect(err).toBeInstanceOf(HttpError)
    expect((err as HttpError).status).toBe(403)
    expect((err as HttpError).code).toBe('cross_origin')
    expect((err as HttpError).message).toBe('Requests from another site are not allowed.')
  })

  test('a different port on the same host is rejected', () => {
    expect(() => guardOrigin(at({ host: 'localhost:3335', origin: 'http://localhost:4000' }))).toThrow(HttpError)
  })

  test('an Origin of "null" (sandboxed or opaque origins) is rejected', () => {
    expect(() => guardOrigin(at({ host: 'localhost:3335', origin: 'null' }))).toThrow(HttpError)
  })

  test('without a Host header, the host of the request URL is used', () => {
    const ok = new Request('http://localhost:3335/api/x', {
      method: 'POST',
      headers: { origin: 'http://localhost:3335' },
    })
    expect(() => guardOrigin(ok)).not.toThrow()
    const bad = new Request('http://localhost:3335/api/x', { method: 'POST', headers: { origin: 'http://other.test' } })
    expect(() => guardOrigin(bad)).toThrow(HttpError)
  })
})

describe('guardMutation', () => {
  const session = `${SESSION_COOKIE}=powdb_abc`
  const req = (method: string, headers: Record<string, string> = {}) =>
    new Request('http://localhost:3335/api/x', { method, headers: { host: 'localhost:3335', ...headers } })

  test('reads (GET, HEAD) are never checked, even with a cross-origin Origin', () => {
    expect(() => guardMutation(req('GET', { origin: 'https://evil.test' }))).not.toThrow()
    expect(() => guardMutation(req('HEAD', { origin: 'https://evil.test', cookie: session }))).not.toThrow()
  })

  test('POST, PUT, PATCH and DELETE with a cross-origin Origin are 403', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(() => guardMutation(req(method, { origin: 'https://evil.test' }))).toThrow(HttpError)
    }
  })

  test('a mutation with no Origin and no session cookie needs no content type', () => {
    expect(() => guardMutation(req('POST', { 'content-type': 'text/plain' }))).not.toThrow()
    expect(() => guardMutation(req('DELETE'))).not.toThrow()
  })

  test('a mutation with the session cookie must send application/json', async () => {
    const err = await rejectionSync(() => guardMutation(req('POST', { cookie: session, 'content-type': 'text/plain' })))
    expect((err as HttpError).status).toBe(400)
    expect((err as HttpError).code).toBe('content_type')
    expect((err as HttpError).message).toBe('Send this request with Content-Type: application/json.')
  })

  test('a session-cookied mutation with no Content-Type is refused', () => {
    expect(() => guardMutation(req('PATCH', { cookie: session }))).toThrow(HttpError)
  })

  test('application/json is accepted with parameters and in any case', () => {
    expect(() => guardMutation(req('POST', { cookie: session, 'content-type': 'application/json' }))).not.toThrow()
    expect(() =>
      guardMutation(req('POST', { cookie: session, 'content-type': 'Application/JSON; charset=utf-8' })),
    ).not.toThrow()
  })

  test('a form content type sent with the session cookie is refused, which is the cross-site form case', () => {
    expect(() =>
      guardMutation(req('POST', { cookie: session, 'content-type': 'application/x-www-form-urlencoded' })),
    ).toThrow(HttpError)
  })

  test('only the session cookie counts: another cookie does not trigger the JSON rule', () => {
    expect(() => guardMutation(req('POST', { cookie: 'theme=dark', 'content-type': 'text/plain' }))).not.toThrow()
  })

  test('an empty session cookie value still counts as carrying the session', () => {
    expect(() => guardMutation(req('POST', { cookie: `${SESSION_COOKIE}=`, 'content-type': 'text/plain' }))).toThrow(
      HttpError,
    )
  })

  test('the origin check runs before the content type check', async () => {
    const err = await rejectionSync(() =>
      guardMutation(req('POST', { origin: 'https://evil.test', cookie: session, 'content-type': 'text/plain' })),
    )
    expect((err as HttpError).code).toBe('cross_origin')
  })
})

/** Like rejection(), for a function that throws synchronously. */
async function rejectionSync(fn: () => unknown): Promise<unknown> {
  try {
    fn()
  } catch (err) {
    return err
  }
  throw new Error('expected a throw')
}

describe('errorToResponse redaction', () => {
  test('an unexpected error keeps its message but never a password from a connection URL', async () => {
    const res = errorToResponse(new Error('could not connect to postgres://admin:hunter2@db:5432/app'))
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toContain('postgres://admin:***@db:5432/app')
    expect(body.error.message).not.toContain('hunter2')
  })
})
