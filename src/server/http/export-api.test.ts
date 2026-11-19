import { expect, test } from 'bun:test'
import { ISOLATED, runInChildProcess } from './test-process'

// Stateful: runs in a child process with its own POWDB_DATA_DIR (see test-process.ts).
// Nothing here reaches a database: every case is refused before a connection is opened,
// and the one connection used points at a closed port.
if (!ISOLATED) {
  test('table export passes in an isolated process', () => runInChildProcess(import.meta.path), 120_000)
} else {
  delete process.env.POWDB_AUTH
  delete process.env.POWDB_ADMIN_PASSWORD

  const auth = await import('@/server/auth.server')
  const store = await import('@/server/store.server')
  const exp = await import('@/server/export.server')

  await auth.setupAdmin('admin', 'correct horse battery')
  const session = (await auth.issueSession()).token
  const localKey = (await auth.getAuthFile()).localKey
  const conn = await store.createConnection({
    name: 'Closed port',
    color: 'blue',
    host: '127.0.0.1',
    port: 1,
    database: 'shop',
    user: 'nobody',
    password: 'none',
    ssl: 'disable',
    readOnly: true,
    aiAccess: 'read',
  })
  const agent = await auth.createApiToken({ name: 'reader', scope: 'admin', connections: 'all', expiresInDays: 1 })

  const query = `connection=${conn.id}&schema=public&table=orders&format=csv`

  async function call(
    qs: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; type: string | null; body: { error?: { code: string; message: string } } | null }> {
    const res = await exp.handleExportRequest(
      new Request(`http://localhost:3335/api/export/table?${qs}`, { method: 'GET', headers }),
    )
    const type = res.headers.get('content-type')
    const body = type?.includes('json') ? ((await res.json()) as never) : null
    if (res.body && !body) await res.body?.cancel()
    return { status: res.status, type, body }
  }

  test('no credentials: 401 JSON', async () => {
    const res = await call(query)
    expect(res.status).toBe(401)
    expect(res.body?.error?.code).toBe('unauthenticated')
  })

  test('an API token (even an admin one) gets 403, not a stream', async () => {
    const res = await call(query, { authorization: `Bearer ${agent.token}` })
    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('forbidden')
  })

  test('a cross-site Origin is refused', async () => {
    const res = await call(query, { cookie: `powdb_session=${session}`, origin: 'https://evil.example' })
    expect(res.status).toBe(403)
    expect(res.body?.error?.code).toBe('cross_origin')
  })

  test('bad parameters are 400 before the database is touched', async () => {
    const withSession = { cookie: `powdb_session=${session}` }
    expect((await call(query.replace('format=csv', 'format=xlsx'), withSession)).status).toBe(400)
    expect((await call('schema=public&table=orders&format=csv', withSession)).status).toBe(400)
    expect((await call(`${query}&filters=oops`, withSession)).status).toBe(400)
  })

  test('an unknown connection is 404', async () => {
    const res = await call('connection=nope&schema=public&table=orders&format=csv', {
      cookie: `powdb_session=${session}`,
    })
    expect(res.status).toBe(404)
  })

  test('the local key counts as the user', async () => {
    const res = await call('connection=nope&schema=public&table=orders&format=csv', {
      'x-powdb-local-key': localKey,
    })
    expect(res.status).toBe(404)
  })

  test('a connection that cannot be reached fails with a JSON error, before any stream starts', async () => {
    const res = await call(query, { cookie: `powdb_session=${session}` })
    expect(res.status).toBe(500)
    expect(res.type).toContain('application/json')
    expect(res.body?.error?.message).toBe('connect ECONNREFUSED 127.0.0.1:1')
  }, 30_000)
}
