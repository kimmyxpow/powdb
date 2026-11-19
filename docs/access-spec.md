# PowDB access: login, API tokens, AI agents (MCP), CLI, config file

This is the contract every part of the implementation follows. Do not change names,
paths or shapes here without updating this file.

Principles

- The UI needs a login. First start: create the admin account (or seed it from env).
- AI agents never see database passwords. They name a connection; PowDB runs the query.
- AI access is limited by default: every connection starts as **read-only for AI**.
- One core, three doors: REST API (`/api/v1`), MCP (`/mcp`), CLI (`powdb`, talks to the REST API). The browser UI uses server functions (`src/api/*.functions.ts`), not REST. Both call the same `src/server/*.server.ts` code.
- Everything also works with zero config in Docker.

## 1. Data directory (`POWDB_DATA_DIR`, default `./.data`, `/data` in Docker)

| File               | Content                                                                                 | Mode   |
| ------------------ | --------------------------------------------------------------------------------------- | ------ |
| `connections.json` | connection store; saved passwords are encrypted (`enc:v1:…`)                            | 0600   |
| `encryption.key`   | random 32-byte key for saved passwords (base64); not created when `POWDB_SECRET` is set | 0600   |
| `auth.json`        | admin account, HMAC secret, local key, API tokens                                       | 0600   |
| `audit.jsonl`      | one JSON line per agent query; rotated to `audit.1.jsonl` at 5 MB                       | 0600   |
| `audit.1.jsonl`    | the previous audit file; each rotation replaces it                                      | 0600   |
| `powdb.yaml`       | optional declarative connections (path overridable with `POWDB_CONFIG`)                 | user's |

The npx launcher uses `~/.powdb` as the data folder unless `--data-dir` or `POWDB_DATA_DIR` says otherwise.

## 2. Environment variables

| Name                   | Default                      | Meaning                                                                                                                                                                                      |
| ---------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                 | `3333`                       | listen port. An invalid value makes `server.ts` exit with a message                                                                                                                          |
| `HOST`                 | `127.0.0.1`                  | listen address (the Docker image sets `0.0.0.0`). A non-default address is added to the accepted `Host` names                                                                                |
| `POWDB_DATA_DIR`       | `./.data`                    | data folder (section 1). The Docker image sets `/data`; the npx launcher uses `~/.powdb`                                                                                                     |
| `POWDB_ALLOWED_HOSTS`  | unset                        | extra accepted `Host` names, comma separated. Other names get 403 (plain text). `localhost`, `127.0.0.1` and `[::1]` are always accepted                                                     |
| `POWDB_CONNECTIONS`    | unset                        | seed connections, used only when `connections.json` does not exist yet. One per line or `;`-separated: `Name=postgresql://...` or a bare URL. Seeded connections start with AI access `read` |
| `POWDB_AUTH`           | `on`                         | `off` disables the login entirely (trusted local use only). Agents still need a token for `/mcp` unless the local key is used.                                                               |
| `POWDB_ADMIN_USER`     | `admin`                      | username used when seeding the admin from env                                                                                                                                                |
| `POWDB_ADMIN_PASSWORD` | unset                        | if set and no admin exists yet, create the admin at start                                                                                                                                    |
| `POWDB_SESSION_DAYS`   | `30`                         | session lifetime                                                                                                                                                                             |
| `POWDB_SECURE_COOKIES` | `auto`                       | `true`/`false`; `auto` = Secure when the request is https (also `x-forwarded-proto: https`)                                                                                                  |
| `POWDB_TRUST_PROXY`    | `false`                      | `true`: behind a reverse proxy. The client IP for the login rate limit is the first address in `X-Forwarded-For` (then `X-Real-IP`). `false`: only the socket address is used                |
| `POWDB_SECRET`         | unset                        | Key source for saved connection passwords (at least 16 characters). When set, it replaces `encryption.key`. Keep it outside the data volume                                                  |
| `POWDB_CONFIG`         | `$POWDB_DATA_DIR/powdb.yaml` | declarative connections file                                                                                                                                                                 |
| `POWDB_URL`            | `http://127.0.0.1:$PORT`     | CLI only: where the server is                                                                                                                                                                |
| `POWDB_TOKEN`          | unset                        | CLI only: API token to use instead of the local key                                                                                                                                          |
| `POWDB_PG_DUMP`        | unset                        | path or command name of `pg_dump` for database export; unset = `pg_dump` on `PATH`. The Docker image sets `/usr/lib/postgresql/18/bin/pg_dump`                                               |
| `POWDB_MAX_IMPORT_MB`  | `200`                        | largest accepted CSV import body, in MB; larger uploads get 413 `too_large`                                                                                                                  |
| `POWDB_PG_BIN`         | unset                        | folder holding `psql` and `pg_restore` for database restore; unset = the folder of the located `pg_dump`, then `PATH`. A missing tool gives 501 `pg_tools_missing`                           |
| `POWDB_MAX_RESTORE_MB` | `2048`                       | largest accepted restore upload, in MB; larger uploads get 413 `too_large`                                                                                                                   |

## 3. Types (put shared ones in `src/lib/types.ts`)

```ts
export type AiAccess = 'off' | 'read' | 'write'
export type TokenScope = 'read' | 'write' | 'admin'
export type Access = 'none' | 'read' | 'write'

// ConnectionConfig gains:
aiAccess: AiAccess
production?: boolean      // missing = false. UI shows a Production marker and asks before every change
managed?: boolean         // true when it comes from powdb.yaml
passwordEnv?: string      // managed only: env var holding the password
ssh?: SshSettings         // SSH tunnel (bastion), see below

// ConnectionInfo (what clients see) gains aiAccess and managed (never password / passwordEnv value).
// ConnectionInfo.ssh is SshInfo: { host, port, user, auth, hasPassword, hasKey, hostKey? } (never a secret,
// never an env var or file name).
// ConnectionInput gains: aiAccess: AiAccess, production?: boolean, and ssh?: SshInput | null
//   production undefined on update = keep; new connections default to false.
//   undefined on update = keep the tunnel; null = remove it.

export type SshAuth = 'password' | 'key'
export interface SshSettings {
  host: string; port: number; user: string; auth: SshAuth
  password?: string        // encrypted (enc:v1:), like the DB password
  privateKey?: string      // encrypted; PEM or OpenSSH text
  passphrase?: string      // encrypted
  hostKey?: string         // "SHA256:<base64>", remembered on first use or pinned in powdb.yaml
  passwordEnv?: string; privateKeyEnv?: string; privateKeyFile?: string; passphraseEnv?: string  // managed only
}
// SshInput: { host, port, user, auth, password?, privateKey?, passphrase?, clearPassword?, clearKey? }
// An empty secret on update keeps the stored one (same rule as the DB password). Changing host or port drops
// the pinned hostKey. A new privateKey also drops the old passphrase.
// TestConnectionResult gains hostKey?: string (the SSH host key seen by the test).

export interface ApiTokenInfo {
  id: string              // 8 chars
  name: string
  prefix: string          // first 12 chars of the token, e.g. "powdb_a1B2c3"
  scope: TokenScope
  connections: 'all' | string[]
  createdAt: string
  /** null = never expires */
  expiresAt: string | null
  lastUsedAt?: string
}

export interface AuditEntry {
  at: string              // ISO time
  source: 'mcp' | 'api' | 'cli'   // the server writes 'mcp' (MCP) or 'api' (REST, which the CLI also uses); 'cli' is never written
  actor: string           // token name, "local CLI", "local" (auth off) or the admin username
  tokenId?: string
  connectionId: string
  connectionName: string
  database: string
  access: 'read' | 'write'
  sql: string             // truncated to 5000 chars
  ok: boolean
  error?: string
  rowCount?: number | null
  durationMs: number
}

export interface AuthState {
  authEnabled: boolean
  setupRequired: boolean  // no admin yet (and auth enabled)
  authenticated: boolean
  username: string | null
}
```

## 4. Server modules

### `src/server/auth.server.ts`

`auth.json`: `{ version: 1, admin: { username, passwordHash, sessionVersion } | null, secret: string (base64, 32 random bytes), localKey: string (base64url, 32 random bytes), tokens: StoredToken[] }`
with `StoredToken = ApiTokenInfo & { hash: string /* sha256 hex of the full token */ }`.
Created on first use with fresh `secret` and `localKey`. In-memory cache + atomic write (tmp file + rename), like `store.server.ts`.

Exports:

- `authEnabled(): boolean` (`POWDB_AUTH !== 'off'`)
- `getAuthFile(): Promise<AuthFile>` (cached; seeds the admin from env on first load)
- `isSetupRequired(): Promise<boolean>`
- `setupAdmin(username, password): Promise<void>` (throws if an admin exists; password >= 8 chars; `Bun.password.hash` with argon2id)
- `authState(sessionToken): Promise<AuthState>` (what the sign-in page and the root guard need)
- `signIn(username, password, ip): Promise<{ token, maxAgeSec }>` (rate limit, then the password check; `Wrong username or password.` on a miss)
- `setUpFirstAdmin(username, password): Promise<{ token, maxAgeSec }>` (only while no admin exists; starts a session)
- `changeOwnPassword(sessionToken, current, next): Promise<{ token, maxAgeSec }>` (needs a valid session and the current password; the new session replaces the old one)
- `verifyLogin(username, password, ip): Promise<boolean>` (rate limit: 10 failures / 15 min / ip, then throws `RateLimitError`). Failures are kept in memory only, so a restart clears them.
- `changePassword(current, next): Promise<void>` and `resetAdminPassword(next): Promise<void>`; both bump `sessionVersion` (logs everyone out). `resetAdminPassword` also creates the admin, named by `POWDB_ADMIN_USER`, when none exists
- `issueSession(): Promise<{ token: string; maxAgeSec: number }>`: token `${expiresMs}.${sessionVersion}.${nonce}.${sig}`, sig = HMAC-SHA256(secret, the first three parts), base64url
- `verifySession(token): Promise<boolean>` (signature, expiry, sessionVersion; constant-time compare)
- `createApiToken({ name, scope, connections, expiresInDays }): Promise<{ token: string; info: ApiTokenInfo }>` token = `powdb_` + 32 random base62 chars, store sha256 only. `expiresInDays`: a positive whole number, or `null` (never). Omitted = 90. `expiresAt = createdAt + days`
- `listApiTokens(): Promise<ApiTokenInfo[]>`, `revokeApiToken(id): Promise<void>`
- `verifyApiToken(token): Promise<ApiTokenInfo | null>` (null when unknown, or when `expiresAt` has passed; updates `lastUsedAt` at most once per minute). Expired tokens stay in `listApiTokens()` until revoked.
- `isLocalKey(candidate: string): Promise<boolean>` (constant-time compare with the stored local key).
- Cookie name constant `SESSION_COOKIE = 'powdb_session'`

### `src/server/access.server.ts`

```ts
export type Principal =
  | { kind: 'user'; label: string }   // signed-in admin (session) or the local CLI key on REST
  | { kind: 'agent'; label: string; scope: TokenScope; connections: 'all' | string[]; tokenId?: string }

authenticate(request: Request, opts: { mcp?: boolean }): Promise<Principal | null>
```

- `Authorization: Bearer powdb_…` → agent principal from the token.
- `X-PowDB-Local-Key: <localKey>` → on REST: `user` ("local CLI"); with `opts.mcp`: agent with scope from header `X-PowDB-Agent-Scope` (`read` default, `write` allowed), label "local CLI".
- Cookie `powdb_session` valid → `user` (label = admin username). With auth disabled every request without other credentials is `user` "local", except `/mcp` which still needs a token or the local key.
- The checks stop at the first credential present. A Bearer header or a local key header that does not match gives `null`, and the session cookie is not tried.

`effectiveAccess(principal, conn): Access`

- user: `conn.readOnly ? 'read' : 'write'`
- agent: `none` if `conn.aiAccess === 'off'` or the token is limited to other connections; otherwise the lowest of (scope: read→read, write/admin→write), `conn.aiAccess`, and `read` when `conn.readOnly`.

`canManageConnections(principal)`: user, or agent with scope `admin`.
`canManageTokens(principal)`: user only.

### `src/server/secret.server.ts`

- `encryptSecret(plain): string` → `enc:v1:<base64 iv, 12 bytes>:<base64 ciphertext + 16-byte GCM tag>` (AES-256-GCM).
- `decryptSecret(stored): string`: a value without the `enc:v1:` prefix is refused with "A stored secret is not encrypted. Save it again.". A bad key or tampered value throws the message "This saved password cannot be decrypted. …".
- `isEncrypted(value)`.
- Key: `POWDB_SECRET` (at least 16 characters, else encryption is refused) → SHA-256 over a fixed domain string and the secret. Otherwise `encryption.key` in the data folder, created on first use.

### `src/server/agent.server.ts`

- `isReadOnlySql(sql): { ok: true } | { ok: false; reason: string }`: exactly one statement (use `splitStatements` from `@/lib/sql`), first keyword (skip comments / leading parens) one of `SELECT WITH EXPLAIN SHOW VALUES TABLE`. Anything else: "Only one read-only statement (SELECT, WITH, EXPLAIN, SHOW, VALUES, TABLE) is allowed with read access."
- `runAgentQuery({ connectionId, database, sql, access, maxRows = 200 (cap 1000), timeoutMs = 15000 (capped at 10 minutes) }): Promise<AgentQueryResult>`
  - `read`: check `isReadOnlySql`; `BEGIN READ ONLY`; `SET LOCAL statement_timeout`; run with a cursor reading `maxRows + 1`; `ROLLBACK` always.
  - `write`: reject `BEGIN/COMMIT/ROLLBACK/ABORT/START/END/SAVEPOINT/RELEASE` statements and `COPY ... FROM STDIN` / `TO STDOUT`; `BEGIN`; `SET LOCAL statement_timeout`; run each statement; `COMMIT` (ROLLBACK on error). Result of the last statement plus total `rowCount`.
  - values as text (use `rawTypes` from `pool.server.ts`), `null` stays null.
  - `AgentQueryResult = { columns: { name: string; type: string }[]; rows: Record<string, string | null>[]; rowCount: number | null; truncated: boolean; durationMs: number; command: string | null }`
- `agentSchemas`, `agentTables` and `agentDescribe` (same file) return the compact shapes that REST and MCP use. They are built on `introspect.server.ts`.

### `src/server/audit.server.ts`

`appendAudit(entry: AuditEntry): Promise<void>` (never throws), `readAudit(limit = 100): Promise<AuditEntry[]>` (newest first).

### `src/server/config.server.ts` (powdb.yaml)

```yaml
connections:
  - id: prod # required, [a-z0-9_-]{1,40}, stable
    name: Production # optional
    url: postgresql://app_ro@db.internal:5432/app?sslmode=require # password in URL optional
    password_env: PROD_PG_PASSWORD # optional, read at connect time
    read_only: true # optional, default false
    production: false # optional, default false (Production marker, confirm before changes)
    ai_access: read # off | read | write, default read
    color: blue # optional, one of CONNECTION_COLORS
    ssh: # optional SSH tunnel
      host: bastion.example.com
      port: 22 # default 22
      user: deploy
      password_env: BASTION_PW # exactly one of password_env, private_key_file, private_key_env
      # private_key_file: /run/secrets/bastion_key   (path inside the container)
      # private_key_env: BASTION_KEY
      # passphrase_env: BASTION_KEY_PASS             (key logins only)
      # host_key: SHA256:...                         (pinned fingerprint, optional)
```

The `ssh` block holds references only; the secrets are read when the tunnel starts.

### `src/server/tunnel.server.ts` and `src/server/ssh-settings.ts`

One `ssh2` client per connection with an SSH tunnel, forwarding a local port on `127.0.0.1` to `host:port` as seen from the SSH server. `ensureTunnel(conn)` starts it once (concurrent callers share the start) and returns the endpoint. A changed setting gives a new tunnel. A dropped SSH connection is re-opened on the next use. `closeTunnel(id)` runs when a connection is saved or removed. `testTunnel(ssh, dbHost, dbPort)` is the temporary tunnel for "Test connection". The host key check is `hostVerifier` with `hostHash: 'sha256'`, formatted like OpenSSH. `ssh-settings.ts` holds the pure parts (fingerprint, cache key, `mergeSshInput`, `sshInfo`). Clients reach PostgreSQL through `connectConfig(conn)` (pools and the SQL editor) and `pgTarget(conn)` (pg_dump; through a tunnel `host=<real host> hostaddr=127.0.0.1 port=<tunnel port>`, so the certificate is checked against the real name).
Parsed with `Bun.YAML.parse` (`.json` files with `JSON.parse`), validated with the project's schema helper (`src/lib/schema.ts`). Unknown keys in a connection or its `ssh` block are refused. On `store.server.ts` load: managed connections are upserted by id (keep `lastUsedAt`), managed ones no longer in the file are removed. Invalid file: `console.warn` and ignore it (never crash). Managed connections cannot be edited or deleted through the UI, API or CLI: throw `Managed by powdb.yaml. Change the file and restart PowDB.`
The pool must use `resolvePassword(conn)` = `conn.passwordEnv ? process.env[conn.passwordEnv] : conn.password`.

### `src/server/http/*.server.ts` and `src/routes/*`

- `core.server.ts`: the rules REST and MCP share. Which connections a principal sees, the access check, the create and edit rules for agents, and `runQuery`, the one audited path that runs a query.
- `util.server.ts`: JSON and error responses, body parsing (1 MB cap for JSON bodies), query and cookie helpers, and the same-origin checks.
- `v1-api.server.ts`, `auth-api.server.ts` and `mcp.server.ts`: the handlers for `/api/v1`, `/api/auth` and `/mcp`.
- The route files in `src/routes/` are thin wrappers that call these handlers.

## 5. HTTP

All JSON. Errors: `{ "error": { "code": string, "message": string } }`. Status codes in use: 400, 401, 403, 404, 405, 409, 413, 422, 429, 500 and 501.
Every POST, PUT, PATCH or DELETE with an `Origin` header must name the same host as `Host` (403 `cross_origin`). A request that carries the session cookie must also send `Content-Type: application/json` (400 `content_type`).

### `/api/auth/*` (file `src/routes/api/auth/$.ts`, splat route; for the CLI only)

- `GET  /api/auth/state` → `AuthState` (the CLI uses it to find the server)
- `POST /api/auth/reset-password` `{ password }` (local key only) → `{ ok: true }`

Sign-in, first-time setup, sign-out and password change are not REST. The browser calls the server functions in `src/api/session.functions.ts` (`authStateFn`, `signInFn`, `completeSetupFn`) and `src/api/account.functions.ts` (`signOutFn`, `changePasswordFn`). They call the same `auth.server.ts` functions and set the same session cookie. The cookie is `HttpOnly; SameSite=Lax; Path=/; Max-Age=<session length in seconds>`, with `Secure` when the request is https (or `POWDB_SECURE_COOKIES` says so). Sign-out sends `Max-Age=0`.

### `/api/v1/*` (file `src/routes/api/v1/$.ts`, splat route with a small internal router)

- `GET    /api/v1/connections` → `(ConnectionInfo & { access: Access })[]` (agents: only `access !== 'none'`)
- `POST   /api/v1/connections` `{ url?, name?, host?, port?, database?, user?, password?, ssl?, readOnly?, production?, aiAccess?, color?, ssh? }` (url or host+database+user; `ssh` is an `SshInput`, see section 3) → 201 `ConnectionInfo`
- `PATCH  /api/v1/connections/:id` same fields, all optional; `ssh: null` removes the tunnel, an omitted `ssh` keeps it; `clearPassword: true` removes the stored password → `ConnectionInfo`
- Invalid SSH settings (no login secret, a key without `PRIVATE KEY`) → 400 `invalid_connection`
- `DELETE /api/v1/connections/:id` → `{ ok: true }`
- `POST   /api/v1/connections/:id/test` → `{ ok, latencyMs, serverVersion }`, or `{ ok: false, error }`. This route does not return `hostKey`. The app's own test does.
- `GET    /api/v1/connections/:id/schemas?database=` → `{ name, isSystem }[]`
- `GET    /api/v1/connections/:id/tables?schema=public&database=` → `{ schema, name, kind, estimatedRows, comment }[]`
- `GET    /api/v1/connections/:id/tables/:schema/:table?database=` → `{ schema, name, kind, comment, columns: { name, type, nullable, default, primaryKey, references }[], indexes: { name, definition }[] }`
- `POST   /api/v1/query` `{ connection, sql, database?, maxRows?, write? }` → `AgentQueryResult`; `write: true` needs effective `write` (else 403 `write_denied`); otherwise runs with `read`. Users (UI session) also go through `runAgentQuery` here (source `api`), audited.
- `GET    /api/v1/tokens` · `POST /api/v1/tokens` `{ name, scope?, connections?, expiresInDays? }` → `{ token, info }` · `DELETE /api/v1/tokens/:id`
  - `expiresInDays`: integer 1..3650, or `null` for a token that never expires. Omitted = 90. Expired tokens get 401 and stay listed until revoked.
- `GET    /api/v1/audit?limit=100` → `AuditEntry[]` (`limit` from 1 to 1000; other values get 400 `invalid_request`)
- The browser's AI access page uses the server functions `listTokensFn`, `createTokenFn`, `revokeTokenFn` (`src/api/tokens.functions.ts`) and `listAuditFn` (`src/api/activity.functions.ts`), which call the same `auth.server.ts` and `audit.server.ts` functions as these routes.
- Connection management needs `canManageConnections`, tokens and audit need `canManageTokens`.
- An agent with `admin` scope can manage connections, but cannot set AI access to `write`, raise AI access, or make a read-only connection writable. Those return 403 `agent_loosening`. A connection an agent creates starts with AI access `read` (or `off`), and is read-only only if asked.
- `connection` / `:id` accepts the id or the exact connection name. A name shared by more than one connection gives 409 `ambiguous_connection`.

### `/api/export/*` (files `src/routes/api/export/table.ts`, `database.ts`, `database/status.ts`)

The route files are thin. The logic is in `export.server.ts` (table export), `dump.server.ts` (database export), and `import-csv.server.ts` and `restore.server.ts` (the `/api/import/*` routes). Calls without credentials get 401 `unauthenticated`.

Signed-in users and the local key only (`authenticate`). API tokens and agents get 403. Successful responses are attachments (`Content-Disposition: attachment`, `Cache-Control: no-store`), not JSON. An error before the first byte is the usual JSON error body. A failure after the body has started ends the stream early and is logged on the server.

- `GET /api/export/table?connection=&schema=&table=&format=csv|json|ndjson|sql` plus optional `database=`, `where=`, `q=`, `filters=`, `sort=` → the rows as a streamed file, `<table>.<ext>`. `connection` takes the id or the exact name. `database` defaults to the connection's database. `filters` (JSON array of `{column, op, value?}`, at most 100), `sort` (JSON array of `{column, direction}`, at most 20), `where` (at most 10,000 characters) and `q` (at most 1,000 characters) are the grid's own, so the export matches the grid. Rows are read in batches of 1000 with a cursor, inside one read-only transaction with no statement timeout. Errors: 400 `invalid_request` (missing or bad parameter), 400 `query_failed` (bad WHERE or SQL), 404 `not_found` (connection or table).
- `GET /api/export/database?connection=&database=&content=all|schema|data&format=sql|sql-gz|custom` plus `schemas=a,b` or `tables=schema.table,...` (comma lists, exclusive, at most 1000 items) → the pg_dump output, named `<database>-<YYYYMMDD-HHmm>.sql`, `.sql.gz` or `.dump`. Here `connection` must be the id: a name is not accepted. `content` defaults to `all`, `format` to `sql`. The password only travels in `PGPASSWORD`, and the arguments are never a shell string. A client that disconnects stops pg_dump. Errors: 400 `invalid_request`, 403 `forbidden` (token or agent), 403 `cross_origin` (session cookie from another site), 404 `not_found` (connection id), 501 `pg_dump_missing`, 500 `pg_dump_failed` (the message holds the end of pg_dump's stderr; sent only when pg_dump fails before writing any output).
- `POST /api/import/csv?connection=&database=&schema=&table=&header=0|1&nullEmpty=0|1&mapping=&delimiter=` with the raw CSV file as the body (not multipart) → `{ inserted: number }`. `connection` is the id. `mapping` is a JSON array of `{ column, source }`, where `source` is the 0-based CSV column index; unknown or generated/identity-ALWAYS columns, a column mapped twice, or a missing NOT NULL column without default are 400. `delimiter` is one character, omitted for auto-detection from the first line. Empty cells become NULL when `nullEmpty=1`. Rows go in batches of up to 500 inside one transaction, and any failure or a client disconnect rolls the whole file back. The body is limited to `POWDB_MAX_IMPORT_MB` (default 200): 413 `too_large`. Errors: 400 `invalid_request`, 403 `forbidden` (token or agent), 403 `cross_origin`, 403 `read_only`, 404 `not_found` (connection or table), 413 `too_large`, 422 `import_failed` (the message starts with `Line n:` or `Lines a-b:` and then the PostgreSQL message).
- `POST /api/import/restore?connection=&database=&format=sql|sql-gz|custom&atomic=0|1&clean=0|1` with the raw backup file as the body (not multipart) → `{ ok, exitCode, errors, log }`. `connection` is the id. The format must match the file's first bytes: `custom` starts with `PGDMP`, `sql-gz` with gzip magic `1f 8b`, `sql` is neither (a mismatch is 400 `invalid_request`, "The file looks like X, not Y."). `atomic=1` runs psql with `ON_ERROR_STOP=1` inside `--single-transaction`, or pg_restore with `--single-transaction --exit-on-error`; `atomic=0` keeps going past errors. `clean=1` (custom only) runs pg_restore with `--clean --if-exists`. `sql-gz` is decompressed while it is written to a temporary directory (mode 0600, removed afterwards). The arguments are an array, the password only travels in `PGPASSWORD`, and a client that disconnects stops the tool. `ok` is true when the exit code is 0; `errors` counts stderr lines that start with `ERROR:`, `psql:<file>:<line>: ERROR:`, `pg_restore: error:` or `psql: error:`. `log` is the last 60 lines of stderr. Status 200 when the tool exits 0 (errors may still be above 0 when `atomic=0`). Otherwise 422 `restore_failed` with the same fields and `error.message`: "The restore stopped with an error. Nothing was changed." (atomic) or "The restore finished with errors." Errors: 400 `invalid_request` (also an empty file, a damaged gzip, or a format mismatch), 403 `forbidden` (token or agent), 403 `cross_origin`, 403 `read_only`, 404 `not_found` (connection), 413 `too_large`, 501 `pg_tools_missing`, 500 `restore_failed` (the tool could not start). Restores into the database named by `database`, which can be any database on that connection.
- `GET /api/export/database/status` → `{ available: boolean, version: string | null }`, where `version` is pg_dump's version (for example `"18.1"`). Same auth as the database export. `Cache-Control: no-store`.

### `/mcp` (file `src/routes/mcp.ts`)

Streamable HTTP, stateless, JSON responses only. `POST` JSON-RPC 2.0 (single message or array). `GET`/`DELETE` → 405.
Auth: Bearer token or local key (`authenticate(req, { mcp: true })`); missing → 401 with `WWW-Authenticate: Bearer`. The session cookie is not accepted here.
Methods: `initialize` (echo the client's protocolVersion when it is one of `2025-06-18`, `2025-03-26`, `2024-11-05`, else `2025-06-18`; `capabilities: { tools: { listChanged: false } }`; `serverInfo: { name: 'powdb', version }`; short `instructions`), `ping`, `tools/list`, `tools/call`; notifications (no `id`) → HTTP 202 with no body. Unknown method → JSON-RPC error -32601.
Tools (results: `{ content: [{ type: 'text', text }], isError? }`, text is compact JSON):

- `list_connections` `{}`: the connections this token can use, with their access level.
- `list_schemas` `{ connection, database? }`
- `list_tables` `{ connection, schema?, database? }`
- `describe_table` `{ connection, table, schema?, database? }`
- `run_query` `{ connection, sql, database?, max_rows?, write? }`. Description must say: read-only by default; writes only when `write: true`, the token allows it and the connection allows AI writes.
- `explain` `{ connection, sql, database?, analyze? }` (analyze runs inside a read-only transaction for read access)
  Tool errors (no access, read-only violation, SQL error) are tool results with `isError: true`, not JSON-RPC errors. Every `run_query` / `explain` is audited with source `mcp`.

### Server functions (UI)

`src/start.ts` adds two global middlewares. `csrfMiddleware` (TanStack's CSRF middleware, applied to server functions only) refuses calls from other origins. `authMiddleware` rejects every server function call without a valid session (when auth is enabled) by throwing `new Error('UNAUTHENTICATED')`. The app then sends the user to `/login?redirect=...`.

The only exceptions are the three functions in `src/api/session.functions.ts`: `authStateFn`, `signInFn` and `completeSetupFn`. They are listed in `src/api/public-functions.ts`. TanStack gives function middleware each function's identity (`serverFnMeta`: the variable name and the file), and the middleware exempts a call only when both match a listed entry. A call with no known identity needs a session. `src/api/public-functions.test.ts` fails if `session.functions.ts` exports a function that is not listed, or a listed function is missing. To add a public function, put it in that file and list it, and give it a reason in the review.

## 6. CLI `powdb` (`cli/powdb.ts`, built to `dist/cli/powdb.js`, installed as `/usr/local/bin/powdb` in the image)

Talks to `/api/v1`, `/mcp`, and the export and import routes. Auth: `POWDB_TOKEN` if set, else the local key read from `$POWDB_DATA_DIR/auth.json` (works inside the container: `docker exec powdb powdb …`).

```
powdb status [--json]
powdb conn list [--json]
powdb conn add <url> [--name N] [--read-only] [--production] [--ai off|read|write] [--color C] [--password-stdin] [--json] [--ssh user@host[:port] (--ssh-key FILE | --ssh-password-stdin)]
powdb conn edit <id|name> [--name N] [--url U] [--read-only | --writable] [--production | --not-production] [--ai off|read|write] [--json] [--ssh user@host[:port]] [--ssh-key FILE | --ssh-password-stdin] [--no-ssh]
powdb conn remove <id|name> [--yes]
powdb conn test <id|name>
powdb tables <conn> [--schema S] [--json]
powdb describe <conn> <table> [--schema S] [--json]
powdb query <conn> "<sql>" [--write] [--json] [--max-rows N]
powdb export <conn> <table> [--schema S] [--format csv|json|ndjson|sql] [--where "<sql condition>"] [--output FILE]
powdb dump <conn> [--database D] [--content all|schema|data] [--format sql|sql-gz|custom] [--schema S]... [--table schema.table]... [--output FILE]
powdb token create <name> [--scope read|write|admin] [--conn id,id] [--expires 30d|90d|1y|never|<n>d] [--json]   (default 90d)
powdb token list [--json]
powdb token revoke <id>
powdb audit [--limit N] [--json]
powdb admin reset-password [--password-stdin]
powdb mcp [--write]          # stdio MCP bridge for agents (Claude Code, Cursor, …)
powdb help
```

Human-readable tables by default, `--json` for scripts. Exit code 1 on errors with the API message on stderr.
`--ssh-key FILE` reads the key file on the machine running the CLI and sends its text. `--ssh-password-stdin` cannot be combined with `--password-stdin`. On `conn edit`, `--ssh` alone keeps the saved login method and secret (and `--ssh-key`/`--ssh-password-stdin` alone keeps the saved host, port and user); `--no-ssh` removes the tunnel.
`powdb export` and `powdb dump` use the local key only (`POWDB_TOKEN` is not sent; the export routes refuse tokens). They stream the response body to the file (or to stdout with `--output -`) and print `Saved <file> (<size>)` to stderr. `export` takes `schema.table` or `--schema`, defaults to `--format csv` and writes `<table>.<format>` in the working directory. `dump` resolves the connection id through `GET /api/v1/connections` (the dump route takes an id, not a name), checks `GET /api/export/database/status` first (when pg_dump is missing it prints the server's pg_dump message and exits 1), then calls `GET /api/export/database`. Its `--schema` and `--table` repeat and cannot be combined. Default output `<database>-<YYYYMMDD-HHmm>.sql` (`.sql.gz` for `sql-gz`, `.dump` for `custom`).

`powdb restore <conn> <file> [--database D] [--keep-going] [--clean]` runs a `.sql`, `.sql.gz` or `.dump` file into a database. The format is read from the file's first bytes, the same way the UI does it. It uses the local key and the restore route above, prints the tool's log to stderr, and prints `Restored <file> into <database>.` on success. `--keep-going` turns off all or nothing; exit code 1 when the run counted errors or failed.
`powdb mcp`: reads newline-delimited JSON-RPC from stdin, POSTs each line to `/mcp` with the local key (or token) and `X-PowDB-Agent-Scope: read|write`, writes each response as one line to stdout; notifications produce no output. Never print anything else to stdout.

## 7. UI

- `/setup` (first start) and `/login` pages; a guard in the root route sends people there. Server function errors `UNAUTHENTICATED` send the user to `/login`.
- Settings dialog has two tabs: **General** (current content) and **Account** (signed in as, change password, sign out).
- **AI access** is a separate dialog, opened from the command palette. Its **Tokens** tab creates tokens (name, scope, connections; shown once, with copy buttons and ready-to-paste MCP setup for Claude Code and Cursor), and lists and revokes them. Its **Activity** tab shows recent agent queries from the audit log.
- Connection dialog: "AI and API access" select: Off / Read only (default) / Read and write, with a one-line hint.
- Sidebar: the database Select lists every database on the server. Command palette "Switch to …" lists them too.
- Managed connections (from powdb.yaml): a "Managed" badge; edit and delete are disabled with a tooltip.
- All copy natural English, no em dashes.
