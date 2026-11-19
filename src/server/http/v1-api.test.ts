import { describe, expect, test } from 'bun:test'
import { ISOLATED, runInChildProcess } from './test-process'

// Stateful: runs in a child process with its own POWVIEW_DATA_DIR (see test-process.ts).
if (!ISOLATED) {
  test('REST API passes in an isolated process', () => runInChildProcess(import.meta.path), 120_000)
} else {
  const { writeFileSync } = await import('node:fs')
  const path = await import('node:path')
  const dataDir = process.env.POWVIEW_DATA_DIR!
  // A managed connection, present from the first store load on.
  writeFileSync(
    path.join(dataDir, 'powview.yaml'),
    'connections:\n  - id: prod\n    url: postgres://app_ro@db.invalid:5432/app\n    password_env: POWVIEW_TEST_PROD_PW\n    read_only: true\n',
  )
  process.env.POWVIEW_TEST_PROD_PW = 'from-env'
  delete process.env.POWVIEW_AUTH
  delete process.env.POWVIEW_ADMIN_PASSWORD

  const auth = await import('@/server/auth.server')
  const store = await import('@/server/store.server')
  const api = await import('./v1-api.server')
  const audit = await import('@/server/audit.server')

  const PASSWORD = 'correct horse battery'
  await auth.setupAdmin('admin', PASSWORD)
  const session = (await auth.issueSession()).token

  type Opts = {
    body?: unknown
    token?: string
    cookie?: boolean
    origin?: string
    contentType?: string
    query?: string
  }

  async function call(method: string, route: string, opts: Opts = {}): Promise<Response> {
    const headers: Record<string, string> = {}
    if (opts.body !== undefined) headers['content-type'] = opts.contentType ?? 'application/json'
    if (opts.token) headers.authorization = `Bearer ${opts.token}`
    if (opts.cookie) headers.cookie = `powview_session=${session}`
    if (opts.origin) headers.origin = opts.origin
    const url = `http://localhost:3335/api/v1/${route}${opts.query ?? ''}`
    const request = new Request(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
    })
    return api.handleV1Request(request, route)
  }

  async function errorBody(res: Response): Promise<{ code: string; message: string }> {
    return ((await res.json()) as { error: { code: string; message: string } }).error
  }

  async function errorCode(res: Response): Promise<string> {
    return (await errorBody(res)).code
  }

  async function errorMessage(res: Response): Promise<string> {
    return (await errorBody(res)).message
  }

  const base = {
    host: '127.0.0.1',
    port: 1,
    database: 'shop',
    user: 'demo',
    password: 'demo',
    ssl: 'disable' as const,
    color: 'blue' as const,
  }
  const C_RW = await store.createConnection({ ...base, name: 'Writable', readOnly: false, aiAccess: 'write' })
  const C_RO = await store.createConnection({ ...base, name: 'Read only', readOnly: true, aiAccess: 'read' })
  const C_OFF = await store.createConnection({ ...base, name: 'Off', readOnly: false, aiAccess: 'off' })
  const C_TMP = await store.createConnection({ ...base, name: 'Temporary', readOnly: false, aiAccess: 'write' })

  async function makeToken(name: string, scope: 'read' | 'write' | 'admin', connections: 'all' | string[]) {
    const res = await call('POST', 'tokens', { cookie: true, body: { name, scope, connections } })
    expect(res.status).toBe(201)
    return (await res.json()) as { token: string; info: { id: string } }
  }

  const adminBot = await makeToken('admin-bot', 'admin', 'all')
  const reader = await makeToken('reader', 'read', 'all')
  const limitedRo = await makeToken('limited-ro', 'read', [C_RO.id])

  describe('credentials', () => {
    test('no credentials is 401 on every REST route', async () => {
      expect((await call('GET', 'connections')).status).toBe(401)
      expect((await call('POST', 'query', { body: { connection: 'x', sql: 'select 1' } })).status).toBe(401)
      expect((await call('GET', 'tokens')).status).toBe(401)
    })

    test('an unknown bearer token is 401', async () => {
      expect((await call('GET', 'connections', { token: 'powview_not-a-real-token' })).status).toBe(401)
    })
  })

  describe('connections', () => {
    test('a user session sees every connection, with access ignoring aiAccess', async () => {
      const rows = (await (await call('GET', 'connections', { cookie: true })).json()) as Array<{
        id: string
        access: string
        managed?: boolean
        password?: string
        passwordEnv?: string
        hasPassword: boolean
      }>
      const byId = new Map(rows.map((r) => [r.id, r]))
      expect(byId.get(C_RW.id)?.access).toBe('write')
      expect(byId.get(C_RO.id)?.access).toBe('read')
      expect(byId.get(C_OFF.id)?.access).toBe('write')
      const prod = rows.find((r) => r.managed)
      expect(prod?.id).toBe('prod')
      expect(prod?.hasPassword).toBe(true)
      expect(JSON.stringify(rows)).not.toContain('"password"')
      expect(JSON.stringify(rows)).not.toContain('from-env')
      expect(rows.every((r) => r.password === undefined && r.passwordEnv === undefined)).toBe(true)
    })

    test('an agent may create a read-only connection, and the password is never echoed', async () => {
      const res = await call('POST', 'connections', {
        token: adminBot.token,
        body: {
          name: 'Agent made',
          host: 'db.example',
          database: 'app',
          user: 'ro',
          password: 'secret-pw-123',
          readOnly: true,
        },
      })
      expect(res.status).toBe(201)
      const text = await res.text()
      const body = JSON.parse(text) as { id: string; readOnly: boolean; aiAccess: string; hasPassword: boolean }
      expect(body.readOnly).toBe(true)
      expect(body.aiAccess).toBe('read')
      expect(body.hasPassword).toBe(true)
      expect(text).not.toContain('secret-pw-123')
      expect(text).not.toContain('password')
      const del = await call('DELETE', `connections/${body.id}`, { token: adminBot.token })
      expect(await del.json()).toEqual({ ok: true })
    })

    test('an agent cannot create a connection that is writable for AI (403)', async () => {
      const res = await call('POST', 'connections', {
        token: adminBot.token,
        body: { name: 'Sneaky', host: 'db.example', database: 'app', user: 'rw', aiAccess: 'write' },
      })
      expect(res.status).toBe(403)
      expect(await errorMessage(res)).toContain('AI write access')
    })

    test('an agent may create an AI-off connection', async () => {
      const res = await call('POST', 'connections', {
        token: adminBot.token,
        body: { name: 'Off made', host: 'db.example', database: 'app', user: 'x', aiAccess: 'off' },
      })
      expect(res.status).toBe(201)
      expect(((await res.json()) as { aiAccess: string }).aiAccess).toBe('off')
    })

    test('an agent cannot loosen aiAccess or readOnly on edit (403)', async () => {
      const unlock = await call('PATCH', `connections/${C_RO.id}`, { token: adminBot.token, body: { readOnly: false } })
      expect(unlock.status).toBe(403)
      expect(await errorMessage(unlock)).toContain('read-only')

      const raise = await call('PATCH', `connections/${C_OFF.id}`, {
        token: adminBot.token,
        body: { aiAccess: 'read' },
      })
      expect(raise.status).toBe(403)
      expect(await errorMessage(raise)).toContain('stricter, not looser')
    })

    test('an agent may tighten aiAccess, and an unchanged loosening value is not a change', async () => {
      const tighten = await call('PATCH', `connections/${C_TMP.id}`, {
        token: adminBot.token,
        body: { aiAccess: 'read', name: 'Temporary renamed' },
      })
      expect(tighten.status).toBe(200)
      const body = (await tighten.json()) as { aiAccess: string; name: string }
      expect(body.aiAccess).toBe('read')
      expect(body.name).toBe('Temporary renamed')

      const same = await call('PATCH', `connections/${C_RO.id}`, {
        token: adminBot.token,
        body: { aiAccess: 'read', readOnly: true, name: 'Read only renamed' },
      })
      expect(same.status).toBe(200)
    })

    test('a user session can loosen aiAccess and readOnly', async () => {
      const res = await call('PATCH', `connections/${C_RO.id}`, {
        cookie: true,
        body: { readOnly: false, aiAccess: 'write' },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { readOnly: boolean; aiAccess: string }
      expect(body.readOnly).toBe(false)
      expect(body.aiAccess).toBe('write')
    })

    test('managed connections answer 409 to edit and delete', async () => {
      const patch = await call('PATCH', 'connections/prod', { cookie: true, body: { name: 'Renamed' } })
      expect(patch.status).toBe(409)
      expect(await errorCode(patch)).toBe('managed')
      const del = await call('DELETE', 'connections/prod', { token: adminBot.token })
      expect(del.status).toBe(409)
      expect(await errorMessage(del)).toBe('Managed by powview.yaml. Change the file and restart PowView.')
    })

    test('an unknown connection is 404', async () => {
      expect((await call('PATCH', 'connections/nope', { cookie: true, body: { name: 'x' } })).status).toBe(404)
    })

    test('invalid input is a 400 with a reason', async () => {
      const empty = await call('POST', 'connections', { cookie: true, body: {} })
      expect(empty.status).toBe(400)
      expect(await errorMessage(empty)).toContain('url, or host, database and user')
      const badUrl = await call('POST', 'connections', { cookie: true, body: { url: 'mysql://x/y' } })
      expect(badUrl.status).toBe(400)
      expect(await errorCode(badUrl)).toBe('invalid_url')
      const notJson = await call('POST', 'connections', { cookie: true, body: '{oops' })
      expect(await errorCode(notJson)).toBe('invalid_json')
    })
  })

  describe('tokens and visibility', () => {
    test('a token limited to a connection it cannot use sees an empty list', async () => {
      // A token whose only connection is off for AI sees nothing at all.
      const offOnly = await makeToken('off-only', 'read', [C_OFF.id])
      const rows = await (await call('GET', 'connections', { token: offOnly.token })).json()
      expect(rows).toEqual([])

      // And a token limited to a connection that is not in the store sees nothing either.
      const ghost = await auth.createApiToken({ name: 'ghost', scope: 'read', connections: ['not-a-connection'] })
      expect(await (await call('GET', 'connections', { token: ghost.token })).json()).toEqual([])
    })

    test('a limited token sees only its own connection and cannot reach the others', async () => {
      const rows = (await (await call('GET', 'connections', { token: limitedRo.token })).json()) as Array<{
        id: string
        access: string
      }>
      expect(rows.map((r) => r.id)).toEqual([C_RO.id])
      expect(rows[0]!.access).toBe('read')
      const hidden = await call('GET', `connections/${C_RW.id}/tables`, { token: limitedRo.token })
      expect(hidden.status).toBe(404)
    })

    test('a read-scope token cannot write, even with write: true (403)', async () => {
      const res = await call('POST', 'query', {
        token: reader.token,
        body: { connection: C_RW.id, sql: 'delete from customers where false', write: true },
      })
      expect(res.status).toBe(403)
      const body = await errorBody(res)
      expect(body.code).toBe('write_denied')
      expect(body.message).toContain('read scope')
    })

    test('the refused write is in the audit log with the token name', async () => {
      const res = await call('GET', 'audit', { cookie: true, query: '?limit=5' })
      expect(res.status).toBe(200)
      const entries = (await res.json()) as Array<{
        source: string
        actor: string
        ok: boolean
        sql: string
        access: string
        tokenId?: string
      }>
      const entry = entries.find((e) => e.sql === 'delete from customers where false')
      expect(entry).toBeDefined()
      expect(entry).toMatchObject({ source: 'api', actor: 'reader', ok: false, access: 'write' })
      expect(entry!.tokenId).toBe(reader.info.id)
    })

    test('an agent cannot manage tokens or read the audit log (403)', async () => {
      expect((await call('GET', 'tokens', { token: reader.token })).status).toBe(403)
      expect((await call('POST', 'tokens', { token: adminBot.token, body: { name: 'x' } })).status).toBe(403)
      expect((await call('GET', 'audit', { token: adminBot.token })).status).toBe(403)
    })

    test('a user creates a token by connection name, lists it without its hash, and revokes it', async () => {
      const created = await call('POST', 'tokens', {
        cookie: true,
        body: { name: 'cli', scope: 'read', connections: ['Read only renamed'] },
      })
      expect(created.status).toBe(201)
      const body = (await created.json()) as { token: string; info: { id: string; connections: string[] } }
      expect(body.token.startsWith('powview_')).toBe(true)
      expect(body.info.connections).toEqual([C_RO.id])

      const list = (await (await call('GET', 'tokens', { cookie: true })).json()) as Array<Record<string, unknown>>
      const row = list.find((t) => t.id === body.info.id)!
      expect(row).toBeDefined()
      expect('hash' in row).toBe(false)

      // Cookie DELETEs must send JSON, so the request carries an empty object.
      expect(await (await call('DELETE', `tokens/${body.info.id}`, { cookie: true, body: {} })).json()).toEqual({
        ok: true,
      })
      expect((await call('GET', 'connections', { token: body.token })).status).toBe(401)
      expect((await call('DELETE', `tokens/${body.info.id}`, { cookie: true, body: {} })).status).toBe(404)
    })

    test('a token cannot be limited to a connection that does not exist', async () => {
      const res = await call('POST', 'tokens', { cookie: true, body: { name: 'bad', connections: ['nope'] } })
      expect(res.status).toBe(404)
    })

    test('the audit limit must be a whole number from 1 to 1000', async () => {
      expect((await call('GET', 'audit', { cookie: true, query: '?limit=0' })).status).toBe(400)
      expect((await call('GET', 'audit', { cookie: true, query: '?limit=abc' })).status).toBe(400)
      const one = (await (await call('GET', 'audit', { cookie: true, query: '?limit=1' })).json()) as unknown[]
      expect(one.length).toBe(1)
    })
  })

  describe('same-origin and content type for cookie requests', () => {
    test('a cookie POST from another origin is refused with 403', async () => {
      const res = await call('POST', 'connections', {
        cookie: true,
        origin: 'https://evil.example',
        body: { name: 'x', host: 'h', database: 'd', user: 'u' },
      })
      expect(res.status).toBe(403)
      expect(await errorCode(res)).toBe('cross_origin')
    })

    test('a cookie POST from the same origin is accepted', async () => {
      const res = await call('POST', 'connections', {
        cookie: true,
        origin: 'http://localhost:3335',
        body: { name: 'Same origin', host: 'h', database: 'd', user: 'u', aiAccess: 'off' },
      })
      expect(res.status).toBe(201)
    })

    test('a cookie POST must send application/json', async () => {
      const res = await call('POST', 'query', {
        cookie: true,
        contentType: 'text/plain',
        body: { connection: C_RO.id, sql: 'select 1' },
      })
      expect(res.status).toBe(400)
      expect(await errorCode(res)).toBe('content_type')
    })
  })

  describe('queries', () => {
    test('a user query against an unknown connection is 404 and still audited', async () => {
      const res = await call('POST', 'query', { cookie: true, body: { connection: 'no-such', sql: 'select 1' } })
      expect(res.status).toBe(404)
      const entries = await audit.readAudit(20)
      expect(entries.some((e) => e.connectionId === 'no-such' && e.source === 'api' && e.ok === false)).toBe(true)
    })

    test('an AI-off connection refuses a token with 403 before any database call', async () => {
      const offOnly = await auth.createApiToken({ name: 'off-user', scope: 'admin', connections: [C_OFF.id] })
      const res = await call('POST', 'query', { token: offOnly.token, body: { connection: C_OFF.id, sql: 'select 1' } })
      expect(res.status).toBe(403)
      const body = await errorBody(res)
      expect(body.code).toBe('no_access')
      expect(body.message).toContain('AI access is off')
    })

    test('a read-only connection refuses a write from a write-scope token (403)', async () => {
      const locked = await store.createConnection({ ...base, name: 'Locked', readOnly: true, aiAccess: 'write' })
      const writer = await auth.createApiToken({ name: 'writer', scope: 'write', connections: 'all' })
      const res = await call('POST', 'query', {
        token: writer.token,
        body: { connection: locked.id, sql: 'delete from customers where false', write: true },
      })
      expect(res.status).toBe(403)
      const body = await errorBody(res)
      expect(body.code).toBe('write_denied')
      expect(body.message).toContain('"Locked" is read-only')
    })

    test('an invalid query body is 400', async () => {
      const res = await call('POST', 'query', { cookie: true, body: { connection: C_RW.id } })
      expect(res.status).toBe(400)
      expect(await errorCode(res)).toBe('invalid_request')
    })
  })

  describe('routing', () => {
    test('unknown endpoints are 404, the wrong method is 405', async () => {
      expect((await call('GET', 'nothing-here', { cookie: true })).status).toBe(404)
      expect((await call('PUT', 'connections', { cookie: true, body: {} })).status).toBe(405)
    })
  })

  describe('auth disabled (POWVIEW_AUTH=off)', () => {
    test('REST answers without credentials as the local user', async () => {
      process.env.POWVIEW_AUTH = 'off'
      try {
        const res = await call('GET', 'connections')
        expect(res.status).toBe(200)
      } finally {
        delete process.env.POWVIEW_AUTH
      }
    })
  })
}
