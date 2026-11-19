# Backup and restore

How to export data, back up a database, restore a backup from the app or the CLI, and import CSV files.

## Export a page or a whole table

**Export a page**: the export button in the table toolbar saves the rows you can see as CSV, JSON, SQL INSERT, or a Markdown table. **Copy to clipboard (TSV)** copies them for a spreadsheet.

**Whole table**: the **Whole table** menu downloads every row as CSV, JSON, JSON lines, or SQL INSERT. If you have a filter, a search, or a WHERE condition, the menu says **All matching rows**. Then only the matching rows are downloaded, in the same order as the grid.

- The file is streamed from the server in batches, so big tables are fine.
- Only signed-in users and the local key can export a whole table. API tokens and AI agents get 403.
- From a terminal, use `powdb export`. See [powdb CLI](ai-and-api.md#powdb-cli).

## Database backup

Open **Backup** in the sidebar footer, or use the command palette (Ctrl/⌘+K, then "Export database").

- **Content**: **Everything** (structure and data), **Structure only**, or **Data only**.
- **Scope**: the whole database, chosen schemas, or chosen tables and views. When you pick tables one by one, functions, types, and `CREATE SCHEMA` are not included.
- **Format**: **SQL file** (`.sql`), **Compressed SQL** (`.sql.gz`), or **pg_dump custom** (`.dump`). The file is named `<database>-<YYYYMMDD-HHmm>` with the matching extension.

A backup does not include `CREATE DATABASE`. Create the target database before you restore.

**pg_dump**: the Docker image includes pg_dump 18. From source, install the PostgreSQL 18 client, or point `POWDB_PG_DUMP` to another pg_dump. pg_dump cannot dump a server that is newer than itself. In that case the backup fails, and the error from pg_dump is shown. The backup dialog also shows the pg_dump version in use.

From a terminal:

```bash
docker exec powdb powdb dump Shop --output - > shop.sql
docker exec powdb powdb dump Shop --schema public --format custom --output - > public.dump
```

All options are in [powdb CLI](ai-and-api.md#powdb-cli). CLI backups use the local key, and API tokens are refused.

## Restore

Open **Restore** in the sidebar footer, or use the command palette (Ctrl/⌘+K, then "Restore database"). The button is disabled on read-only connections.

- **File**: `.sql`, `.sql.gz`, or `.dump` (pg_dump custom). The format is read from the file's content, not its name.
- **All or nothing** (on by default): the first error stops the run, and all changes are undone. Turn it off to skip failed statements and keep going. The number of errors shows with the log.
- **Drop existing objects first** (`.dump` only): every object is dropped before it is created again.
- Type the database name to confirm. The dialog stays open until the restore ends.
- Only signed-in users and the local key can restore. API tokens and AI agents get 403.

**Restore into an empty database.** A backup file contains `CREATE` commands for tables and other objects. If the target database already has objects with the same names, the restore fails partway or leaves mixed data. Create a new database first, or use **Drop existing objects first** on purpose. Make a backup before a restore if you might need to undo it.

From a terminal:

```bash
powdb restore shop shop-20261117-1138.sql
powdb restore shop shop-20261117-1138.dump --clean
powdb restore shop shop-20261117-1138.sql.gz --keep-going
```

- The format is detected from the file's content. `--keep-going` turns off all-or-nothing. The CLI then exits with code 1 if there were errors.
- `--clean` works only with `.dump` files.
- In Docker, copy the file into the container first: `docker cp shop.sql powdb:/tmp/shop.sql`, then run `docker exec powdb powdb restore shop /tmp/shop.sql`.

Restore needs `psql` and `pg_restore` on the server. The Docker image includes both. From source, install the PostgreSQL 18 client, or set `POWDB_PG_BIN` to the folder that holds both. The file size limit is `POWDB_MAX_RESTORE_MB` (default 2048 MB).

## Restore a backup outside PowDB

Use these commands to restore a backup without PowDB, for example on another server:

```bash
# .sql: plain SQL, run with psql
createdb -h host -U user target_db
psql "postgresql://user:pass@host:5432/target_db" -f shop-20261117-1138.sql

# .sql.gz: SQL compressed with gzip
gunzip -c shop-20261117-1138.sql.gz | psql -d "postgresql://user:pass@host:5432/target_db"

# .dump: pg_dump custom format, restored with pg_restore
pg_restore --no-owner -d "postgresql://user:pass@host:5432/target_db" shop-20261117-1138.dump
```

## CSV import

- Open a table, then click **Import CSV** (the upload icon) in the toolbar. The button appears for tables and partitioned tables, not for views. It is disabled on read-only connections.
- Choose a `.csv`, `.tsv`, or `.txt` file, or drop it on the drop area. The options are:
  - **First row is a header**
  - **Delimiter**: Auto, Comma, Semicolon, Tab, or Pipe
  - **Empty cells become NULL**
  - The preview shows the first 5 rows.
- Each table column is matched to a CSV column by name. Case does not matter, and `_`, `-`, and spaces are ignored. You can change any match, or skip a column to use its default.
- `ALWAYS` identity columns and generated columns are filled by the database, so they cannot be matched. A NOT NULL column with no default must be matched.
- All rows go in one transaction. If one row fails (for example, a value of the wrong type, or a broken constraint), no rows are saved. The error names the CSV row, or the range of rows for a batch.
- The file size limit is 200 MB. Change it with `POWDB_MAX_IMPORT_MB`.
- Only signed-in users and the local key can import. API tokens and AI agents get 403.
- On a production connection, the import asks you to confirm first. See [Production mode](configuration.md#production-mode).
