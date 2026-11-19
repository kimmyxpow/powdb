# AI and API

How to connect AI agents over MCP, create and revoke API tokens, use the REST API, and run the `powview` CLI.

The access rules, field details, and error codes are in [access-spec.md](access-spec.md), the contributor reference.

## AI agents over MCP

AI agents (such as Claude Code, Cursor, and Claude Desktop) never see database passwords. An agent names a connection, and pow/view runs the query with the saved credentials.

Access is limited by default. A new connection has AI access `read`, so agents can only read. Set **AI and API access** for each connection to `off`, `read`, or `write`. Use the connection dialog, or `powview conn edit --ai`.

A write runs only when all four of these are true:

1. the token's scope is `write` or `admin`,
2. the token is allowed to use this connection,
3. the connection's AI access is `write`,
4. the connection is not read-only.

The agent must also pass `write: true` for each write (`run_query`). Without it, the query runs read-only.

Set up Claude Code over HTTP, with a token:

```bash
claude mcp add --transport http powview http://127.0.0.1:3333/mcp --header "Authorization: Bearer <token>"
```

Set up Claude Code through the container. No token is needed, because it uses the local key inside Docker:

```bash
claude mcp add powview -- docker exec -i powview powview mcp
```

Add `--write` at the end to allow writes (`... powview mcp --write`). This only opens write access at the agent level. The connection must still have AI access `write`.

For Cursor or Claude Desktop, add this to the MCP config file. Over HTTP:

```json
{
  "mcpServers": {
    "powview": {
      "url": "http://127.0.0.1:3333/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Through the container:

```json
{
  "mcpServers": {
    "powview": {
      "command": "docker",
      "args": ["exec", "-i", "powview", "powview", "mcp"]
    }
  }
}
```

Tools for agents:

| Tool               | What it does                                                                  |
| ------------------ | ----------------------------------------------------------------------------- |
| `list_connections` | Lists the connections the agent may use, and the access level of each.        |
| `list_schemas`     | Lists the schemas of a connection.                                            |
| `list_tables`      | Lists tables and views.                                                       |
| `describe_table`   | Shows the columns, types, and indexes of a table.                             |
| `run_query`        | Runs SQL. Read-only, unless `write: true` is set and write access is allowed. |
| `explain`          | Shows the query plan. With `analyze`, runs the statement read-only.           |

Every `run_query` and `explain` call is written to the audit log. See [Audit log](#audit-log).

Keep the token in the MCP config file like any other secret. Do not commit it to git, for example in `.mcp.json`.

## API tokens

Tokens let agents and scripts call pow/view from outside the browser. Create one in the command palette (Ctrl/⌘+K, then **AI access**), or with `powview token create`.

- **Scope**: `read`, `write`, or `admin`. An `admin` token can also create, change, and delete connections. Even then, an agent cannot raise a connection's AI access, give it AI write access, or make a read-only connection writable. Only the signed-in admin can do those. An agent never reads the audit log, whatever its scope.
- **Connections**: `--conn id,id` limits a token to some connections, by id or exact name. Without it, the token can use every connection that allows AI access, within its scope.
- **Lifetime**: 90 days by default. `--expires` takes `30d`, `90d`, `1y`, `never`, or `<n>d` (1 to 3650 days).
- **Shown once**: copy the token when it is created. pow/view keeps only a hash of it.
- **Expired tokens** are refused, but stay in the list until you revoke them. Revoke with `powview token revoke <id>`, or in **AI access**.
- **Limits**: tokens cannot export a whole table, import CSV, back up a database, or restore one. Those requests get 403. Only the signed-in admin, or the local key, can do them.

Give agents a database role with limited rights, for example one that can only `SELECT` from the tables they need. The read-only check in pow/view is an extra safety net, not the only protection.

## REST API

The REST API is under `/api/v1`. It takes and returns JSON. Send `Authorization: Bearer <token>`.

| Method | Path                                            | What it does                                |
| ------ | ----------------------------------------------- | ------------------------------------------- |
| GET    | `/api/v1/connections`                           | List connections                            |
| POST   | `/api/v1/connections`                           | Create a connection (needs `admin` scope)   |
| PATCH  | `/api/v1/connections/:id`                       | Change a connection (needs `admin` scope)   |
| DELETE | `/api/v1/connections/:id`                       | Delete a connection (needs `admin` scope)   |
| POST   | `/api/v1/connections/:id/test`                  | Test a connection                           |
| GET    | `/api/v1/connections/:id/schemas`               | List schemas                                |
| GET    | `/api/v1/connections/:id/tables`                | List tables and views                       |
| GET    | `/api/v1/connections/:id/tables/:schema/:table` | Show columns, types, and indexes of a table |
| POST   | `/api/v1/query`                                 | Run SQL                                     |
| GET    | `/api/v1/tokens`                                | List tokens (signed-in admin only)          |
| POST   | `/api/v1/tokens`                                | Create a token (signed-in admin only)       |
| DELETE | `/api/v1/tokens/:id`                            | Revoke a token (signed-in admin only)       |
| GET    | `/api/v1/audit`                                 | Read the audit log (signed-in admin only)   |

Errors use the form `{ "error": { "code": "...", "message": "..." } }`. Every query, through REST or MCP, is written to the audit log. Field details and error codes are in [access-spec.md](access-spec.md).

## powview CLI

`powview` is already installed in the Docker image. Inside the container, the CLI reads the local key from `/data/auth.json` by itself, so this is enough:

```bash
docker exec powview powview conn list
```

Outside Docker, build first and then run from `dist`:

```bash
bun run build
bun dist/cli/powview.js conn list
```

Outside the container, set `POWVIEW_URL` (default `http://127.0.0.1:3333`) and `POWVIEW_TOKEN` to use a token. Without `POWVIEW_TOKEN`, the CLI uses the local key from `POWVIEW_DATA_DIR/auth.json` (default `./.data`). Tokens are meant for remote use. Export, dump, restore, and password reset always use the local key. Run them where `POWVIEW_DATA_DIR` points to the data folder, or through `docker exec`.

| Command                                                                                                                                                                                                                            | What it does                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `powview status [--json]`                                                                                                                                                                                                          | Shows the server URL, whether login is set up, and whether the CLI can connect.                                              |
| `powview conn list [--json]`                                                                                                                                                                                                       | Lists connections and your access to each one.                                                                               |
| `powview conn add <url> [--name N] [--read-only] [--production] [--ai off\|read\|write] [--color C] [--password-stdin] [--json]` `[--ssh user@host[:port] (--ssh-key FILE \| --ssh-password-stdin)]`                               | Adds a connection from a URL. `--password-stdin` reads the password from stdin. `--production` marks it as production.       |
| `powview conn edit <id\|name> [--name N] [--url U] [--read-only \| --writable] [--production \| --not-production] [--ai off\|read\|write] [--json]` `[--ssh user@host[:port]] [--ssh-key FILE \| --ssh-password-stdin] [--no-ssh]` | Changes a connection. Only the flags you pass are changed. `--no-ssh` removes the SSH tunnel.                                |
| `powview conn remove <id\|name> [--yes]`                                                                                                                                                                                           | Removes a connection. Asks first unless `--yes` is given.                                                                    |
| `powview conn test <id\|name>`                                                                                                                                                                                                     | Checks that pow/view can reach the database.                                                                                 |
| `powview tables <conn> [--schema S] [--json]`                                                                                                                                                                                      | Lists tables, views, and other relations.                                                                                    |
| `powview describe <conn> <table> [--schema S] [--json]`                                                                                                                                                                            | Shows the columns, keys, and indexes of a table. Accepts `schema.table`.                                                     |
| `powview query <conn> "<sql>" [--write] [--json] [--max-rows N]`                                                                                                                                                                   | Runs SQL. Read-only unless `--write` is given.                                                                               |
| `powview export <conn> <table> [--schema S] [--format csv\|json\|ndjson\|sql] [--where "<condition>"] [--output FILE]`                                                                                                             | Exports a whole table, or the rows matching `--where`, to a file. Default `<table>.<format>`. `--output -` writes to stdout. |
| `powview dump <conn> [--database D] [--content all\|schema\|data] [--format sql\|sql-gz\|custom] [--schema S]... [--table schema.table]... [--output FILE]`                                                                        | Backs up a database with pg_dump. Default `<database>-<YYYYMMDD-HHmm>.sql` (`.sql.gz` or `.dump` for those formats).         |
| `powview restore <conn> <file> [--database D] [--keep-going] [--clean]`                                                                                                                                                            | Runs a `.sql`, `.sql.gz`, or `.dump` file into a database. See [Restore](backup-restore.md#restore).                         |
| `powview token create <name> [--scope read\|write\|admin] [--conn id,id] [--expires 30d\|90d\|1y\|never\|<n>d] [--json]`                                                                                                           | Creates an API token, shown once. Lasts 90 days unless `--expires` is given.                                                 |
| `powview token list [--json]`                                                                                                                                                                                                      | Lists tokens, with their expiry. Secrets are never shown.                                                                    |
| `powview token revoke <id>`                                                                                                                                                                                                        | Revokes an API token.                                                                                                        |
| `powview audit [--limit N] [--json]`                                                                                                                                                                                               | Shows recent queries and who ran them. Default 20 entries.                                                                   |
| `powview admin reset-password [--password-stdin]`                                                                                                                                                                                  | Sets a new admin password.                                                                                                   |
| `powview mcp [--write]`                                                                                                                                                                                                            | Runs the MCP bridge over stdio for agents (Claude Code, Cursor, and similar tools).                                          |
| `powview help`                                                                                                                                                                                                                     | Shows help.                                                                                                                  |

Examples:

```bash
docker exec powview powview conn add "postgresql://app:secret@db:5432/shop" --name Shop --read-only
docker exec powview powview query Shop "select count(*) from orders"
docker exec powview powview token create claude --scope read --conn Shop
docker exec -it powview powview admin reset-password
```

The default output is a table. Use `--json` in scripts. Errors go to stderr, with exit code 1.

Export examples. Inside the container, write to stdout and redirect the output to a file on your machine (backup examples are in [Backup and restore](backup-restore.md#database-backup)):

```bash
docker exec powview powview export Shop orders --where "status = 'paid'" --format ndjson --output - > paid.ndjson
docker exec powview powview export Shop analytics.page_views --output - > page_views.csv
```

Without `--output`, the file is saved in the working folder with the default name. API tokens are refused for export and dump.

## Audit log

Every query an agent runs, through MCP or REST, is written to `POWVIEW_DATA_DIR/audit.jsonl` (mode `0600`). It has one JSON line per query, including `run_query` and `explain`. When the file reaches 5 MB, it is moved to `audit.1.jsonl`, which replaces the previous rotated file.

- See the log in the **AI access** dialog (command palette, then the Activity tab), or with `powview audit`.
- Only the signed-in admin can read the log through REST. API tokens cannot.
