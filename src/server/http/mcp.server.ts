import { describeError } from '@/lib/redact'
import { s, toJSONSchema, type Infer, type Schema } from '@/lib/schema'
import { authenticate, effectiveAccess, type Principal } from '@/server/access.server'
import { agentDescribe, agentSchemas, agentTables } from '@/server/agent.server'
import { compactConnection, dbCall, findConnection, requireAccess, runQuery, visibleConnections } from './core.server'
import { HttpError, errorResponse, errorToResponse, readText } from './util.server'

/**
 * MCP over HTTP (Streamable HTTP, stateless, JSON responses only). Tool failures are tool
 * results with isError; only protocol problems become JSON-RPC errors.
 */

const SERVER_VERSION = '0.1.0'
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']
const LATEST_VERSION = '2025-06-18'

const INSTRUCTIONS =
  'PowDBs gives you access to PostgreSQL connections. Call list_connections first, then list_schemas, ' +
  'list_tables and describe_table to learn the schema, and run_query for SQL. Queries are read-only ' +
  'unless the token and the connection allow writes and you pass write: true. Connections are named by id ' +
  'or exact name. Results are capped by max_rows.'

class RpcError extends Error {
  readonly code: number

  constructor(code: number, message: string) {
    super(message)
    this.name = 'RpcError'
    this.code = code
  }
}

type Json = Record<string, unknown>

export async function handleMcpRequest(request: Request): Promise<Response> {
  try {
    if (request.method !== 'POST') {
      return errorResponse(405, 'method_not_allowed', 'MCP over HTTP accepts POST only.', { Allow: 'POST' })
    }
    const principal = await authenticate(request, { mcp: true })
    if (!principal) {
      return errorResponse(401, 'unauthenticated', 'Send a PowDBs API token or the local key.', {
        'WWW-Authenticate': 'Bearer',
      })
    }

    let body: unknown
    try {
      body = JSON.parse(await readText(request))
    } catch {
      return rpcJson(rpcError(null, -32700, 'Parse error: the body is not valid JSON.'), 400)
    }

    if (Array.isArray(body)) {
      if (body.length === 0) return rpcJson(rpcError(null, -32600, 'Invalid Request: empty batch.'), 400)
      const replies: Json[] = []
      for (const message of body) {
        const reply = await handleMessage(principal, message)
        if (reply) replies.push(reply)
      }
      return replies.length === 0 ? accepted() : rpcJson(replies)
    }

    const reply = await handleMessage(principal, body)
    return reply ? rpcJson(reply) : accepted()
  } catch (err) {
    // Request-level problems (such as an oversized body) keep their HTTP status.
    if (err instanceof HttpError) return errorToResponse(err)
    console.error('[powdbs] MCP request failed:', describeError(err))
    return rpcJson(rpcError(null, -32603, 'Internal error.'), 500)
  }
}

function accepted(): Response {
  return new Response(null, { status: 202 })
}

function rpcJson(payload: unknown, status = 200): Response {
  return Response.json(payload, { status })
}

function rpcError(id: unknown, code: number, message: string): Json {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

/** One JSON-RPC message. Returns null for notifications and client responses, which get no reply. */
async function handleMessage(principal: Principal, message: unknown): Promise<Json | null> {
  if (!isObject(message)) return rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object.')
  const hasId = 'id' in message
  const id = hasId ? (message.id as unknown) : undefined

  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    // A reply from the client to something we never sent: nothing to do.
    if (!('method' in message) && ('result' in message || 'error' in message)) return null
    return rpcError(id, -32600, 'Invalid Request: expected jsonrpc "2.0" and a method.')
  }

  // Notifications have no id. Nothing needs a reply, so the endpoint answers 202.
  if (!hasId) return null
  if (id !== null && typeof id !== 'string' && typeof id !== 'number') {
    return rpcError(null, -32600, 'Invalid Request: id must be a string, number or null.')
  }

  try {
    const result = await dispatch(principal, message.method, message.params)
    return { jsonrpc: '2.0', id, result }
  } catch (err) {
    if (err instanceof RpcError) return rpcError(id, err.code, err.message)
    console.error('[powdbs] MCP method failed:', describeError(err))
    return rpcError(id, -32603, 'Internal error.')
  }
}

async function dispatch(principal: Principal, method: string, params: unknown): Promise<unknown> {
  switch (method) {
    case 'initialize': {
      const requested = isObject(params) && typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
      return {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : LATEST_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'powdbs', version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      }
    }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) }
    case 'tools/call':
      return callTool(principal, params)
    default:
      throw new RpcError(-32601, `Method not found: ${method}`)
  }
}

interface ToolDef {
  name: string
  description: string
  inputSchema: Json
  parse: (raw: unknown) => unknown
  run: (p: Principal, args: unknown) => Promise<unknown>
}

function defineTool<S extends Schema<unknown, unknown>>(def: {
  name: string
  description: string
  schema: S
  run: (p: Principal, args: Infer<S>) => Promise<unknown>
}): ToolDef {
  const json = toJSONSchema(def.schema)
  delete json.$schema
  return {
    name: def.name,
    description: def.description,
    inputSchema: json,
    parse(raw) {
      const parsed = def.schema.safeParse(raw ?? {})
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        const where = issue ? issue.path.map(String).join('.') : ''
        const message = issue ? `${where ? `${where}: ` : ''}${issue.message}` : 'Invalid arguments.'
        throw new RpcError(-32602, `Invalid params: ${message}`)
      }
      return parsed.data
    },
    run: (p, args) => def.run(p, args as Infer<S>),
  }
}

const connectionRef = s.string().trim().min(1).describe('Connection id, or its exact name.')
const databaseArg = s
  .string()
  .trim()
  .min(1)
  .optional()
  .describe('Database on the connection. Defaults to the connection database.')
const schemaArg = s
  .string()
  .trim()
  .min(1)
  .optional()
  .describe('Schema name. Defaults to all user schemas (tables) or public (describe).')

const TOOLS: ToolDef[] = [
  defineTool({
    name: 'list_connections',
    description: 'List the PostgreSQL connections this token can use, with their access level (read or write).',
    schema: s.object({}),
    run: async (p) => {
      const visible = (await visibleConnections(p)).filter((c) => effectiveAccess(p, c) !== 'none')
      return visible.map((c) => compactConnection(c, effectiveAccess(p, c)))
    },
  }),

  defineTool({
    name: 'list_schemas',
    description: 'List the schemas of a connection, with whether each is a system schema.',
    schema: s.object({ connection: connectionRef, database: databaseArg }),
    run: async (p, args) => {
      const conn = await findConnection(p, args.connection)
      requireAccess(p, conn)
      return dbCall(() => agentSchemas(conn.id, args.database))
    },
  }),

  defineTool({
    name: 'list_tables',
    description: 'List tables, views and other relations on a connection, with estimated row counts and comments.',
    schema: s.object({ connection: connectionRef, schema: schemaArg, database: databaseArg }),
    run: async (p, args) => {
      const conn = await findConnection(p, args.connection)
      requireAccess(p, conn)
      return dbCall(() => agentTables(conn.id, args.database, args.schema))
    },
  }),

  defineTool({
    name: 'describe_table',
    description:
      'Describe one table: its columns (type, nullability, default, primary key, references), indexes and comment.',
    schema: s.object({
      connection: connectionRef,
      table: s.string().trim().min(1).describe('Table name.'),
      schema: schemaArg,
      database: databaseArg,
    }),
    run: async (p, args) => {
      const conn = await findConnection(p, args.connection)
      requireAccess(p, conn)
      return dbCall(() => agentDescribe(conn.id, args.database, args.schema ?? 'public', args.table))
    },
  }),

  defineTool({
    name: 'run_query',
    description:
      'Run one SQL statement and return up to max_rows rows. Read-only by default: writes only when write is true, ' +
      'the token allows it and the connection allows AI writes. Results are text values; null stays null.',
    schema: s.object({
      connection: connectionRef,
      sql: s.string().min(1).describe('One SQL statement.'),
      database: databaseArg,
      max_rows: s.number().int().min(1).max(1000).optional().describe('Row limit, default 200, maximum 1000.'),
      write: s.boolean().optional().describe('Set true to run a write. Needs write access on the connection.'),
    }),
    run: (p, args) =>
      runQuery(p, 'mcp', {
        connection: args.connection,
        sql: args.sql,
        database: args.database,
        maxRows: args.max_rows,
        write: args.write,
      }),
  }),

  defineTool({
    name: 'explain',
    description:
      'Show the query plan for one read-only statement. With analyze true the statement also runs, inside a read-only transaction.',
    schema: s.object({
      connection: connectionRef,
      sql: s.string().min(1).describe('One read-only SQL statement.'),
      database: databaseArg,
      analyze: s.boolean().optional().describe('Run the statement and report actual timings.'),
    }),
    run: (p, args) =>
      runQuery(p, 'mcp', {
        connection: args.connection,
        sql: args.sql,
        database: args.database,
        explain: { analyze: args.analyze === true },
      }),
  }),
]

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

async function callTool(principal: Principal, params: unknown): Promise<Json> {
  if (!isObject(params) || typeof params.name !== 'string') {
    throw new RpcError(-32602, 'Invalid params: name is required.')
  }
  const tool = TOOLS_BY_NAME.get(params.name)
  if (!tool) throw new RpcError(-32602, `Invalid params: unknown tool "${params.name}".`)
  const args = tool.parse(params.arguments)
  try {
    const data = await tool.run(principal, args)
    return { content: [{ type: 'text', text: JSON.stringify(data) }] }
  } catch (err) {
    // Access problems, read-only violations and SQL errors are results the agent can read.
    return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true }
  }
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
