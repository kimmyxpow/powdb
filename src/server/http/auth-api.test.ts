import { expect, test, beforeAll } from 'bun:test'
import { ISOLATED, runInChildProcess } from './test-process'

// Stateful: runs in a child process with its own POWDBS_DATA_DIR (see test-process.ts).
// Covers the REST routes the CLI still uses (/api/auth/state and /api/auth/reset-password).
// Sign-in, setup and password flows are tested in src/server/auth-flow.test.ts.
if (!ISOLATED) {
  test('auth endpoints pass in an isolated process', () => runInChildProcess(import.meta.path), 120_000)
} else {
  const LOCAL_URL = 'http://localhost:3335'

  delete process.env.POWDBS_AUTH
  delete process.env.POWDBS_ADMIN_PASSWORD
  delete process.env.POWDBS_SECURE_COOKIES

  const auth = await import('@/server/auth.server')
  const api = await import('./auth-api.server')

  async function call(
    method: string,
    route: string,
    opts: { body?: unknown; headers?: Record<string, string>; origin?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { ...opts.headers }
    if (opts.body !== undefined) headers['content-type'] = 'application/json'
    if (opts.origin) headers.origin = opts.origin
    const request = new Request(`${LOCAL_URL}/api/auth/${route}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
    return api.handleAuthRequest(request, route)
  }

  beforeAll(async () => {
    expect(await auth.isSetupRequired()).toBe(true)
  })

  test('GET state before setup reports setupRequired and not authenticated', async () => {
    const res = await call('GET', 'state')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      authEnabled: true,
      setupRequired: true,
      authenticated: false,
      username: null,
    })
  })

  test('the browser routes moved to server functions: their old REST paths are gone', async () => {
    for (const [method, route] of [
      ['POST', 'login'],
      ['POST', 'setup'],
      ['POST', 'logout'],
      ['POST', 'password'],
    ] as const) {
      const res = await call(method, route, { body: { username: 'admin', password: 'correct horse battery' } })
      expect(res.status).toBe(404)
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found')
    }
    expect(await auth.isSetupRequired()).toBe(true)
  })

  test('unknown endpoints are 404 and the wrong method is 405', async () => {
    expect((await call('POST', 'nope', { body: {} })).status).toBe(404)
    expect((await call('POST', 'state', { body: {} })).status).toBe(405)
    expect((await call('GET', 'reset-password')).status).toBe(405)
  })

  test('reset-password needs the local key', async () => {
    const none = await call('POST', 'reset-password', { body: { password: 'correct horse battery' } })
    expect(none.status).toBe(401)
    const wrongKey = await call('POST', 'reset-password', {
      headers: { 'x-powdbs-local-key': 'not-the-key' },
      body: { password: 'correct horse battery' },
    })
    expect(wrongKey.status).toBe(401)
  })

  test('a cross-site reset-password is refused before anything else happens', async () => {
    const key = (await auth.getAuthFile()).localKey
    const res = await call('POST', 'reset-password', {
      headers: { 'x-powdbs-local-key': key },
      origin: 'https://evil.example',
      body: { password: 'correct horse battery' },
    })
    expect(res.status).toBe(403)
    expect(await auth.isSetupRequired()).toBe(true)
  })

  test('reset-password with the local key creates the admin when there is none, and state follows', async () => {
    const key = (await auth.getAuthFile()).localKey
    const res = await call('POST', 'reset-password', {
      headers: { 'x-powdbs-local-key': key },
      body: { password: 'correct horse battery' },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const state = (await (await call('GET', 'state')).json()) as { setupRequired: boolean }
    expect(state.setupRequired).toBe(false)
  })
}
