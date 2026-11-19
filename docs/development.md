# Development

For contributors: how to run PowDB from source, build and release it, check the code, and find your way around the project. For what PowDB does for users, see the [README](../README.md). The access layer's internal contract is in [access-spec.md](access-spec.md).

## Prerequisites

- [Bun](https://bun.sh) 1.4.4, the same version as the Docker image.
- A PostgreSQL database you can reach, or Docker for the demo database.
- For backup and restore from source, the PostgreSQL 18 client tools (`psql`, `pg_dump`, `pg_restore`), or point `POWDB_PG_DUMP` and `POWDB_PG_BIN` to binaries you already have. See [Backup and restore](backup-restore.md).

## Run from source

```bash
bun install
bun run dev          # http://localhost:3333
```

The first time you open it, create an admin account. See [Login and admin account](configuration.md#login-and-admin-account).

`bun install` runs a `postinstall` script that deletes the native builds of `ssh2` and `cpu-features`. PowDB does not use them. It uses the pure JavaScript code path instead.

## Demo database

```bash
bun run demo:db      # PostgreSQL 17 with sample data on port 55432
bun run demo:down    # remove it, with its data
```

Paste `postgresql://demo:demo@localhost:55432/shop` on the start page. The `shop` database has the `public` and `analytics` schemas. A second database, `warehouse`, lets you try switching databases on one server.

The `showcase` schema has objects for trying each feature:

- `type_zoo`: one column per type, with extreme values, NULL, unicode and emoji, multi-line text, `infinity`, `NaN`, and BC dates.
- `Mixed Case Table` and `order`: names that must be quoted.
- `wide_table` (60 columns) and `empty_table` (CHECK, UNIQUE, FK, and a domain).
- `settings`, `employees`, `projects`, and `assignments`: text keys, jsonb values, self-references, cross-schema and composite keys.
- `events`: a table partitioned by month, with a default partition.
- `room_bookings`: an EXCLUDE constraint. Try to create a clashing booking.
- `documents`: large JSON, long Markdown, and a binary PNG.
- `cache_entries`: an UNLOGGED table with no primary key.
- `warehouse_locations`: a foreign table to the `warehouse` database.
- `active_employees`, `category_tree`, and `department_stats`: a simple, a recursive, and a materialized view.
- `reports_of`, `format_amount`, `slow_query`, and `raise_demo`: set-returning functions, overloads, a slow query (try Cancel), and NOTICE, WARNING, and ERROR messages.

In `public`, `customers.country_code` is a foreign key to `countries`. `orders.is_gift` and `countries.eu_member` are booleans that can be NULL.

To run the built app with the demo database in Docker:

```bash
docker compose up -d --build   # PowDB on http://localhost:3333, with the "Demo shop" connection
docker compose logs -f app     # show app logs (Ctrl+C to stop)
docker compose down            # add -v to also delete connections, accounts, and demo data
```

Then open http://localhost:3333, create an admin account, and click **Demo shop**. This stack and `bun run demo:db` use the same demo container, so run only one of them.

## Build and start for production

```bash
bun run build
bun run start        # http://127.0.0.1:3333
```

- `bun run build` runs the Vite build, compresses the assets (`scripts/precompress.ts`), and builds the CLI to `dist/cli/powdb.js`.
- `bun run start` runs `server.ts`. It listens on `HOST` (default `127.0.0.1`) and `PORT` (default `3333`). All variables are in [Configuration](configuration.md#environment-variables).

## Docker image

The `Dockerfile` has three stages:

1. **Build** (`oven/bun:1.4.4-slim`): installs dependencies with `bun install --frozen-lockfile`, then builds the client, the server, and the CLI. The server bundles all its dependencies (`ssr.noExternal` in `vite.config.ts`), so the runtime image needs no `node_modules`. This stage runs on the build machine's CPU, even for arm64 images, because its output is the same for every CPU.
2. **PostgreSQL client** (`debian:trixie-slim`): installs `postgresql-client-18` from the PostgreSQL repository, and checks the signing key by its fingerprint. Only `pg_dump`, `pg_restore`, and `psql`, with the libraries they need, are copied into the runtime image.
3. **Runtime** (`oven/bun:1.4.4-distroless`): no shell and no package manager. It runs as `1000:1000`, has a `/data` volume, and has a healthcheck that requests `/` every 30 seconds.

Defaults set in the image: `NODE_ENV=production`, `HOST=0.0.0.0`, `PORT=3333`, `POWDB_DATA_DIR=/data`, and `POWDB_PG_DUMP=/usr/lib/postgresql/18/bin/pg_dump`. The `powdb` CLI is at `/usr/local/bin/powdb`.

`docker-compose.yml` (the development stack) runs two services. `app` is built from source and creates the "Demo shop" connection with `POWDB_CONNECTIONS`. `postgres` comes from `demo/docker-compose.yml`. `compose.example.yml` is the user-facing file, which pulls the published image.

### Build the image yourself

```bash
docker build -t powdb .
```

Run it with the `docker run` command in [Install and update](install.md#run-with-docker), using `powdb` as the image name.

To build both CPU types at once, use buildx:

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/powroom/powdb:test .
```

A multi-platform build cannot be loaded into the local image store. Add `--push` to push it to a registry, or build one platform with `--load`, for example `docker buildx build --platform linux/arm64 --load -t powdb .`. Building arm64 on an x86 machine uses emulation. Docker Desktop has it built in. On Linux, the publish workflow installs it with `docker/setup-qemu-action`.

### Published image

`.github/workflows/publish-image.yml` runs the checks, builds amd64 and arm64, and pushes `ghcr.io/powroom/powdb` when a version tag (`v*.*.*`) is pushed. A manual run from a branch (**Actions > Publish image > Run workflow**) pushes only a `sha-...` tag. The workflow does not check that the tag matches `package.json`, so keep them the same.

## npm package

The `powdb` npm package runs the same build without Docker. The server still runs on Bun, so the package starts Bun for the user. For what users see, see [Install and update](install.md#run-with-npx).

- `scripts/pack-npm.ts` assembles `npm-package/` from the build outputs. It copies only the files it lists, and writes a `package.json` with no dependencies and no scripts. `npm-package/` is in `.gitignore` and `.dockerignore`.
- `npm/bin/powdb.mjs` is the entry point, and `npm/lib/launcher.mjs` holds the logic. Both are plain JavaScript that runs on Node 18 or newer, and on Bun. `npm/launcher.test.ts` tests the helpers (argument parsing, Bun version check, data folder, Bun lookup, notices). It uses no network.
- `bun run build:npm` runs the build, bundles `start.js` as the Dockerfile does, and packs the result. `bun run pack:npm` packs existing build outputs only.

Build and try the package locally. Nothing is installed globally:

```bash
bun run build:npm                                          # build, bundle start.js, assemble npm-package/
npm pack ./npm-package --pack-destination ~/powdb-test     # a tarball with exactly what users get
cd ~/powdb-test && npx ./powdb-0.1.0.tgz                   # run it the way users do
```

The first run asks before it installs Bun. Add `--yes` to test the install path without a prompt. To test the notices without Bun, run the launcher with a `PATH` that has no `bun` in it, and a temporary `HOME`, so your real `~/.powdb` is not touched.

Publishing:

- Releases are published by `.github/workflows/publish-npm.yml` when a version tag is pushed. It uses npm trusted publishing: no npm token is stored in GitHub, and the package gets a provenance statement.
- Trusted publishing is set up once on npmjs.com: package `powdb`, Settings, Trusted publishing, GitHub Actions, with organization `powroom`, repository `powdb`, and workflow `publish-npm.yml`. npm drops the setting when it is not used for a successful publish within 2 days, so add it on the day of a release.
- The very first version has to be published by hand, because trusted publishing can only be set up for a package that exists: `npm login`, then `bun run build:npm` and `npm publish ./npm-package --access public`.
- The workflow skips a version that is already on npm, so pushing the tag for a version published by hand still builds the image and the GitHub Release.

## Release a new version

1. Set `version` in `package.json` to the new number, for example `0.1.1`, and commit the change.
2. Run the checks: `bun check`, `bun run lint`, `bun test`, and `bun fmt --check`.
3. Create the tag and push it: `git tag v0.1.1`, then `git push origin v0.1.1`.

The publish workflows run the same checks again. If one fails, nothing is published. Otherwise the image is built for amd64 and arm64, and published as `0.1.1`, `0.1`, and `latest`. Every build also gets a `sha-...` tag.

The publish image workflow then creates the GitHub Release for the tag, titled `PowDB 0.1.1`, with notes generated from the merged pull requests and commits. If that release already exists, the job leaves it as it is. PowDB reads this release to show its update notice.

To test the update notice without a real release, run a small local server that answers with release JSON (`tag_name`, `html_url`, `published_at`, `body`), and start PowDB with `POWDB_UPDATE_URL` set to that address. This variable is for local testing only. The build version comes from `package.json`, so the notice only appears when the test release has a higher version.

After the first release only, make the package public. On GitHub, open **Packages > powdb > Package settings** and set the visibility to **Public**. New packages are private, so nobody can pull them until you do this.

## Checks and guardrails

| Command             | What it does                                       |
| ------------------- | -------------------------------------------------- |
| `bun check`         | TypeScript type check (the `typecheck` script).    |
| `bun run lint`      | oxlint with `--deny-warnings`. Target: 0 problems. |
| `bun test`          | Unit tests in `src`, `cli`, `scripts`, and `npm`.  |
| `bun run fmt`       | Formats the code with `bun fmt`.                   |
| `bun run fmt:check` | Checks the formatting without changing files.      |

The format options are in `bunfig.toml`: line width 120, 2-space indent, no semicolons, single quotes, trailing commas everywhere, and parentheses around arrow function parameters.

Guardrails:

- **Lint must show 0 problems**: `bun run lint`.
- **No comments that turn off checks.** `scripts/guardrails.test.ts` scans `src`, `cli`, `scripts`, and `server.ts`. It fails on a comment that disables a check, such as ts-ignore, ts-expect-error, ts-nocheck, or a lint or Biome disable comment. Fix the code instead.
- **No silent exclusions.** Formatting exclusions live only in `bunfig.toml`.
- **Tests need no database.** They use fake clients and a fake `pg_dump` (see `src/server/cursor.test.ts` for an example). Do not add tests that connect to a real database. If a test must check that dangerous SQL is refused, never send truly dangerous SQL to a database. Use `where false`, a temporary table, or an update that changes nothing.
- **Access layer changes**: the contract in [access-spec.md](access-spec.md) must match the code. Update it in the same change.

## React Compiler

- The React Compiler runs through `reactCompilerPreset` (`babel-plugin-react-compiler`) in `vite.config.ts`, with `panicThreshold: 'all_errors'`. A component the compiler rejects fails the build. It is never left out of memoization without a warning.
- `@babel/core` stays on version 7.x (currently `^7.29`). `babel-plugin-react-compiler` 1.0 is built on Babel 7 types. With Babel 8 it rejects valid code, for example default values in destructuring. Do not upgrade `@babel/core` to 8 until the plugin supports it.
- A known compiler limit: `import()` inside a component cannot be compiled. That is why `sql-formatter` is loaded through a separate function in `sql-workspace.tsx`.

## Project structure

```
src/
  api/              server functions (createServerFn) called from the UI
  server/           server-only code: connection pool, catalog, data, SQL execution, export,
                    import, dump, restore, auth, access rules, audit log, SSH tunnels
    http/           REST handlers (/api/v1), MCP, and the auth endpoints
  components/
    ui/             coss ui components (installed with the shadcn CLI, see components.json)
    ui-extra/       extra components built on top of coss ui
    app/            app shell: sidebar, command palette, connection, backup, restore, AI access dialogs
    grid/           data grid (virtualized, editable)
    table/          Data and Structure tabs, filters, row drawer, pending changes, CSV import
    sql/            SQL editor (CodeMirror) and result panel
    diagram/        relations diagram (ER)
  hooks/            React hooks (for example use-hotkey for shortcuts)
  lib/              shared types, SQL helpers, React Query queries, small stores, export, dialog logic
  routes/           file-based routing with TanStack Router (including /mcp and /api/*)
  start.ts          server middleware: same-origin checks and the sign-in gate for server functions
cli/                powdb CLI (powdb.ts), built to dist/cli/powdb.js
demo/               docker compose file and sample data (init/01-03 SQL)
npm/                npm launcher (bin and lib) and its tests
scripts/            precompress.ts, pack-npm.ts, guardrails.test.ts
server.ts           production server (Bun)
dist/               build output (client, server, and CLI)
.github/workflows/  image and npm publishing
```

`lib/create-store.ts` is a small store built on `useSyncExternalStore`, with a `persist` middleware that saves to localStorage. The SQL tabs and display settings use it.

## Tech stack

- **App**: TanStack Start, TanStack Router, and TanStack Query, with React 19 and Vite 8.
- **UI**: coss ui (built on Base UI, `@base-ui/react`), Tailwind CSS v4, and lucide icons.
- **SQL editor**: CodeMirror 6 and `sql-formatter`.
- **Database**: node-postgres (`pg`), and `ssh2` for SSH tunnels.
- **Tooling**: Bun (runtime, CLI build, tests, formatting, and `check`), oxlint for linting, and Babel with the React Compiler.

## Next steps

- Persistent SQL sessions (transactions that last across runs)
- An EXPLAIN visualizer
- MySQL and SQLite support
