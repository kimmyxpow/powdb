import { describe, expect, test } from 'bun:test'
import { ISOLATED, runInChildProcess } from './test-process'
import { FIXTURE, revive } from '@/lib/__fixtures__/schema-compat'

// Stateful: runs in a child process with its own POWVIEW_DATA_DIR (see test-process.ts).
if (!ISOLATED) {
  test('MCP endpoint passes in an isolated process', () => runInChildProcess(import.meta.path), 120_000)
} else {
  delete process.env.POWVIEW_AUTH
  delete process.env.POWVIEW_ADMIN_PASSWORD

  const auth = await import('@/server/auth.server')
  const store = await import('@/server/store.server')
  const audit = await import('@/server/audit.server')
  const mcp = await import('./mcp.server')

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

  const reader = await auth.createApiToken({ name: 'reader', scope: 'read', connections: 'all' })
  const writer = await auth.createApiToken({ name: 'writer', scope: 'write', connections: 'all' })
  const offOnly = await auth.createApiToken({ name: 'off-only', scope: 'read', connections: [C_OFF.id] })
  await auth.setupAdmin('admin', 'correct horse battery')
  const session = (await auth.issueSession()).token

  type Opts = { token?: string; localKey?: string; scope?: string; cookie?: boolean; raw?: string }

  async function rpc(body: unknown, opts: Opts = {}): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (opts.token) headers.authorization = `Bearer ${opts.token}`
    if (opts.localKey) headers['x-powview-local-key'] = opts.localKey
    if (opts.scope) headers['x-powview-agent-scope'] = opts.scope
    if (opts.cookie) headers.cookie = `powview_session=${session}`
    const request = new Request('http://localhost:3335/mcp', {
      method: 'POST',
      headers,
      body: opts.raw ?? JSON.stringify(body),
    })
    return mcp.handleMcpRequest(request)
  }

  async function call(
    name: string,
    args: unknown,
    opts: Opts = {},
  ): Promise<{ isError?: boolean; text: string; raw: Record<string, unknown> }> {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, opts)
    const raw = (await res.json()) as { result: { content: Array<{ type: string; text: string }>; isError?: boolean } }
    return {
      isError: raw.result.isError,
      text: raw.result.content[0]!.text,
      raw: raw as unknown as Record<string, unknown>,
    }
  }

  describe('transport and auth', () => {
    test('GET and DELETE are 405', async () => {
      const get = await mcp.handleMcpRequest(new Request('http://localhost:3335/mcp', { method: 'GET' }))
      expect(get.status).toBe(405)
      expect(get.headers.get('allow')).toBe('POST')
      const del = await mcp.handleMcpRequest(new Request('http://localhost:3335/mcp', { method: 'DELETE' }))
      expect(del.status).toBe(405)
    })

    test('no credentials is 401 with a Bearer challenge', async () => {
      const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' })
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toBe('Bearer')
    })

    test('a browser session cookie does not authenticate MCP', async () => {
      const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { cookie: true })
      expect(res.status).toBe(401)
    })

    test('an invalid token is 401', async () => {
      expect((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { token: 'powview_nope' })).status).toBe(401)
    })

    test('a parse error is JSON-RPC -32700 with HTTP 400', async () => {
      const res = await rpc(null, { token: reader.token, raw: '{not json' })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: { code: number } }
      expect(body.error.code).toBe(-32700)
    })

    test('a message without jsonrpc 2.0 is -32600 and keeps its id', async () => {
      const res = await rpc({ id: 7, method: 'ping' }, { token: reader.token })
      const body = (await res.json()) as { id: number; error: { code: number } }
      expect(body.id).toBe(7)
      expect(body.error.code).toBe(-32600)
    })
  })

  describe('protocol', () => {
    test('initialize echoes a supported protocol version', async () => {
      const res = await rpc(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
        },
        { token: reader.token },
      )
      const body = (await res.json()) as { id: number; result: Record<string, unknown> }
      expect(body.id).toBe(1)
      expect(body.result.protocolVersion).toBe('2024-11-05')
      expect(body.result.capabilities).toEqual({ tools: { listChanged: false } })
      expect(body.result.serverInfo).toMatchObject({ name: 'powview' })
      expect(typeof body.result.instructions).toBe('string')
    })

    test('initialize with an unknown version answers the latest one', async () => {
      const res = await rpc(
        { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
        { token: reader.token },
      )
      expect(((await res.json()) as { result: { protocolVersion: string } }).result.protocolVersion).toBe('2025-06-18')
    })

    test('tools/list names the six tools with object input schemas', async () => {
      const res = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { token: reader.token })
      const tools = (
        (await res.json()) as {
          result: { tools: Array<{ name: string; inputSchema: { type: string }; description: string }> }
        }
      ).result.tools
      expect(tools.map((t) => t.name).sort()).toEqual([
        'describe_table',
        'explain',
        'list_connections',
        'list_schemas',
        'list_tables',
        'run_query',
      ])
      for (const tool of tools) expect(tool.inputSchema.type).toBe('object')
      const runQuery = tools.find((t) => t.name === 'run_query')!
      expect(runQuery.description).toContain('Read-only by default')
      expect(runQuery.description).toContain('write is true')
    })

    test('ping answers an empty result', async () => {
      const res = await rpc({ jsonrpc: '2.0', id: 4, method: 'ping' }, { token: reader.token })
      expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 4, result: {} })
    })

    test('a notification (no id) is answered with 202 and no body', async () => {
      const res = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, { token: reader.token })
      expect(res.status).toBe(202)
      expect(await res.text()).toBe('')
    })

    test('an unknown method is -32601', async () => {
      const res = await rpc({ jsonrpc: '2.0', id: 5, method: 'resources/list' }, { token: reader.token })
      const body = (await res.json()) as { id: number; error: { code: number } }
      expect(body.id).toBe(5)
      expect(body.error.code).toBe(-32601)
    })

    test('a batch answers the requests and skips the notifications', async () => {
      const res = await rpc(
        [
          { jsonrpc: '2.0', id: 1, method: 'ping' },
          { jsonrpc: '2.0', method: 'notifications/initialized' },
        ],
        { token: reader.token },
      )
      const replies = (await res.json()) as Array<{ id: number }>
      expect(replies.map((r) => r.id)).toEqual([1])
      const onlyNotifications = await rpc([{ jsonrpc: '2.0', method: 'notifications/initialized' }], {
        token: reader.token,
      })
      expect(onlyNotifications.status).toBe(202)
    })
  })

  describe('tools', () => {
    test('list_connections shows only connections the token can use, without secrets', async () => {
      const res = await call('list_connections', {}, { token: reader.token })
      expect(res.isError).toBeUndefined()
      const rows = JSON.parse(res.text) as Array<{ id: string; access: string }>
      const ids = rows.map((r) => r.id).sort()
      expect(ids).toEqual([C_RO.id, C_RW.id].sort())
      expect(rows.find((r) => r.id === C_RW.id)!.access).toBe('read')
      expect(res.text).not.toContain('password')
    })

    test('a token with no access sees an empty list', async () => {
      const res = await call('list_connections', {}, { token: offOnly.token })
      expect(JSON.parse(res.text)).toEqual([])
    })

    test('a tool on a connection without access is an isError result, not a JSON-RPC error', async () => {
      const res = await call('run_query', { connection: C_OFF.id, sql: 'select 1' }, { token: offOnly.token })
      expect(res.isError).toBe(true)
      expect(res.text).toContain('AI access is off')
      expect(res.raw.error).toBeUndefined()
    })

    test('a connection the token cannot see does not exist for it', async () => {
      const res = await call('describe_table', { connection: C_RW.id, table: 'customers' }, { token: offOnly.token })
      expect(res.isError).toBe(true)
      expect(res.text).toContain('No connection matches')
    })

    test('a read-scope token gets an isError result for write: true', async () => {
      const res = await call(
        'run_query',
        { connection: C_RW.id, sql: 'delete from customers where false', write: true },
        { token: reader.token },
      )
      expect(res.isError).toBe(true)
      expect(res.text).toContain('read scope')
      expect(res.raw.error).toBeUndefined()
    })

    test('explain refuses a non-read statement with read access (isError)', async () => {
      const res = await call(
        'explain',
        { connection: C_RW.id, sql: 'delete from customers where false' },
        { token: reader.token },
      )
      expect(res.isError).toBe(true)
      expect(res.text).toContain('Only one read-only statement')
    })

    test('invalid arguments are a JSON-RPC -32602 error', async () => {
      const missing = await rpc(
        {
          jsonrpc: '2.0',
          id: 9,
          method: 'tools/call',
          params: { name: 'run_query', arguments: { connection: C_RW.id } },
        },
        { token: reader.token },
      )
      expect(((await missing.json()) as { error: { code: number } }).error.code).toBe(-32602)
      const tooMany = await rpc(
        {
          jsonrpc: '2.0',
          id: 10,
          method: 'tools/call',
          params: { name: 'run_query', arguments: { connection: C_RW.id, sql: 'select 1', max_rows: 5000 } },
        },
        { token: reader.token },
      )
      expect(((await tooMany.json()) as { error: { code: number } }).error.code).toBe(-32602)
    })

    test('an unknown tool is a JSON-RPC -32602 error', async () => {
      const res = await rpc(
        { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'drop_everything', arguments: {} } },
        { token: reader.token },
      )
      expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32602)
    })

    test('the local key acts as a read-scope agent unless told otherwise', async () => {
      const key = (await auth.getAuthFile()).localKey
      const res = await call('list_connections', {}, { localKey: key, scope: 'read' })
      const rows = JSON.parse(res.text) as Array<{ id: string; access: string }>
      expect(rows.find((r) => r.id === C_RO.id)!.access).toBe('read')
      const write = await call(
        'run_query',
        { connection: C_RW.id, sql: 'delete from customers where false', write: true },
        { localKey: key },
      )
      expect(write.isError).toBe(true)
      expect(write.text).toContain('read scope')
    })

    test('the write-scope token still cannot write to a read-only connection', async () => {
      const locked = await store.createConnection({ ...base, name: 'Locked', readOnly: true, aiAccess: 'write' })
      const res = await call(
        'run_query',
        { connection: locked.id, sql: 'delete from customers where false', write: true },
        { token: writer.token },
      )
      expect(res.isError).toBe(true)
      expect(res.text).toContain('read-only')
    })

    test('every run_query and explain is audited with source mcp', async () => {
      const entries = await audit.readAudit(50)
      const mcpEntries = entries.filter((e) => e.source === 'mcp')
      expect(mcpEntries.length).toBeGreaterThanOrEqual(4)
      expect(mcpEntries.every((e) => e.ok === false)).toBe(true)
      const forReader = mcpEntries.find(
        (e) => e.actor === 'reader' && e.sql === 'delete from customers where false' && e.connectionId === C_RW.id,
      )
      const readerId = (await auth.listApiTokens()).find((t) => t.name === 'reader')!.id
      expect(forReader).toMatchObject({ actor: 'reader', ok: false, tokenId: readerId })
      const explained = mcpEntries.find(
        (e) => e.sql === 'delete from customers where false' && e.error?.includes('read-only'),
      )
      expect(explained).toMatchObject({ source: 'mcp', ok: false, error: expect.stringContaining('read-only') })
    })
  })

  describe('tool schemas and argument checks match the recorded fixture', () => {
    test('tools/list gives the same input schemas', async () => {
      const res = await rpc({ jsonrpc: '2.0', id: 50, method: 'tools/list' }, { token: reader.token })
      const tools = ((await res.json()) as { result: { tools: Array<{ name: string; inputSchema: unknown }> } }).result
        .tools
      expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(FIXTURE.mcpTools).sort())
      for (const tool of tools) expect(tool.inputSchema).toStrictEqual(FIXTURE.mcpTools[tool.name]!.inputSchema)
    })

    test('every recorded tools/call argument set is accepted or refused as before', async () => {
      let id = 1000
      for (const [name, calls] of Object.entries(FIXTURE.mcpCalls)) {
        for (const call of calls) {
          const res = await rpc(
            { jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: revive(call.input) } },
            { token: reader.token },
          )
          const body = (await res.json()) as { error?: { code: number; message: string } }
          const label = `${name} ${JSON.stringify(call.input)}`
          if (call.ok) expect({ label, error: body.error }).toStrictEqual({ label, error: undefined })
          else expect({ label, error: body.error }).toStrictEqual({ label, error: call.error })
        }
      }
    })
  })
}
