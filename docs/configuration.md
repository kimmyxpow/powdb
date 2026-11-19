# Configuration

How to set up pow/view: environment variables, connections in `powview.yaml`, SSH tunnels, login, production mode, and file size limits.

## Environment variables

If a variable is not set, its default is used. A size or session value that is not valid or not positive also uses its default. An invalid `PORT` stops pow/view with a message.

| Name                     | Default                                              | What it does                                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                   | `3333`                                               | Port to listen on. A whole number from 1 to 65535.                                                                                                                                       |
| `HOST`                   | `127.0.0.1`                                          | Address to listen on. The Docker image sets it to `0.0.0.0`.                                                                                                                             |
| `POWVIEW_DATA_DIR`       | `./.data` (`/data` in Docker, `~/.powview` with npx) | Data folder: `connections.json`, `auth.json`, `encryption.key`, `audit.jsonl`, and `powview.yaml`.                                                                                       |
| `POWVIEW_ALLOWED_HOSTS`  | not set                                              | Extra host names pow/view accepts, separated by commas. `localhost`, `127.0.0.1`, and `[::1]` always work, and so does a `HOST` address that is not `0.0.0.0`. Other host names get 403. |
| `POWVIEW_CONNECTIONS`    | not set                                              | Connections created on the first start, one per line (or separated by `;`), as `Name=postgresql://...` or just a URL. Used only when `connections.json` does not exist yet.              |
| `POWVIEW_CONFIG`         | `$POWVIEW_DATA_DIR/powview.yaml`                     | Where the `powview.yaml` file is.                                                                                                                                                        |
| `POWVIEW_AUTH`           | `on`                                                 | `off` turns login off completely. Only for trusted local use, because anyone who can reach the port gets in.                                                                             |
| `POWVIEW_ADMIN_USER`     | `admin`                                              | Admin username, when the admin is created from environment variables (1 to 64 characters).                                                                                               |
| `POWVIEW_ADMIN_PASSWORD` | not set                                              | If set and no admin exists yet, the admin is created at start. At least 8 characters.                                                                                                    |
| `POWVIEW_SESSION_DAYS`   | `30`                                                 | How many days a sign-in lasts.                                                                                                                                                           |
| `POWVIEW_SECURE_COOKIES` | `auto`                                               | `true` or `false`. `auto` sends Secure cookies when the request uses HTTPS.                                                                                                              |
| `POWVIEW_TRUST_PROXY`    | `false`                                              | Set to `true` behind a reverse proxy. The client IP for login limits then comes from `X-Forwarded-For` (or `X-Real-IP`). With `false`, only the connecting address is used.              |
| `POWVIEW_SECRET`         | not set                                              | Key that encrypts saved database passwords, at least 16 characters. When set, it replaces `encryption.key`. Keep it outside the data folder.                                             |
| `POWVIEW_PG_DUMP`        | not set                                              | Path or command name of `pg_dump`, for database backups. Empty: `pg_dump` from `PATH`. In the Docker image: `/usr/lib/postgresql/18/bin/pg_dump`.                                        |
| `POWVIEW_PG_BIN`         | not set                                              | Folder with `psql` and `pg_restore`, for restores. Empty: the folder where `pg_dump` is, then `PATH`.                                                                                    |
| `POWVIEW_MAX_IMPORT_MB`  | `200`                                                | Largest CSV import file, in MB.                                                                                                                                                          |
| `POWVIEW_MAX_RESTORE_MB` | `2048`                                               | Largest restore file, in MB.                                                                                                                                                             |
| `POWVIEW_UPDATE_CHECK`   | `on`                                                 | `off` turns off the check for new releases. `false` and `0` work too. See [Update](install.md#update).                                                                                   |
| `NODE_ENV`               | not set                                              | Set to `production` by the Docker image.                                                                                                                                                 |
| `POWVIEW_URL`            | `http://127.0.0.1:$PORT`                             | CLI only: the server address.                                                                                                                                                            |
| `POWVIEW_TOKEN`          | not set                                              | CLI only: an API token to use instead of the local key.                                                                                                                                  |

The names you use in `password_env` and `ssh` settings (for example `SHOP_PG_PASSWORD`) are chosen by you in `powview.yaml`. See below.

**Update check privacy:** once a day, the pow/view server asks `api.github.com` for the latest release. That request carries only the User-Agent `powview/<version>`. With npx, the launcher also asks `registry.npmjs.org` once when it starts. `POWVIEW_UPDATE_CHECK=off` turns off both checks.

## Connections from powview.yaml

You can also declare connections in a YAML file. This is useful when your setup is kept as code. Put the file in one of these places:

- **Docker**: add `./powview.yaml:/data/powview.yaml:ro` to the `volumes` of the `app` service in your `compose.yml`.
- **Without Docker**: put it in the `POWVIEW_DATA_DIR` folder, or set its location with `POWVIEW_CONFIG`.

```yaml
connections:
  - id: shop
    name: Shop
    url: postgresql://app_ro@db.internal:5432/shop?sslmode=require
    password_env: SHOP_PG_PASSWORD
    read_only: true
    ai_access: read
    color: blue

  - id: warehouse
    name: Warehouse
    url: postgresql://reader@db.internal:5432/warehouse
    ai_access: off
```

The password is read from an environment variable when the connection is opened. Put its value in `.env` or in your shell environment, not in the YAML file.

| Field          | Required | Meaning                                                                                                  |
| -------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `id`           | yes      | A fixed id: lowercase letters, digits, `-`, or `_`, 1 to 40 characters.                                  |
| `url`          | yes      | Connection URL (`postgres://` or `postgresql://`). A password can go here, but `password_env` is better. |
| `name`         | no       | Name shown in the app. Default: `database @ host`.                                                       |
| `password_env` | no       | Name of the environment variable that holds the password.                                                |
| `read_only`    | no       | Default `false`.                                                                                         |
| `production`   | no       | Default `false`. See [Production mode](#production-mode).                                                |
| `ai_access`    | no       | `off`, `read`, or `write`. Default `read`.                                                               |
| `color`        | no       | One of `neutral`, `blue`, `emerald`, `amber`, `rose`, `violet`, `cyan`, `orange`. Default `neutral`.     |
| `ssh`          | no       | SSH tunnel block. See [SSH tunnel](#ssh-tunnel).                                                         |

Connections from this file are marked **Managed**. You cannot edit or delete them in the app, the API, or the CLI. To change one, edit the file and restart pow/view (`docker compose restart app`). A connection you remove from the file is removed after the restart too. If the file is not valid, pow/view logs a warning and ignores the file. It keeps the connections it already has, and keeps running.

A full example with comments is in [`powview.example.yaml`](../powview.example.yaml) in the repository root.

## SSH tunnel

If a database can only be reached from another server (a bastion), connect through SSH. In the connection form, turn on **Connect through SSH**, fill in the SSH host and user, then log in with a password or a private key. Enter the database host and port as the SSH server sees them, usually `localhost` and `5432`.

- **Test connection** also goes through the tunnel. It shows the SSH host key fingerprint.
- pow/view remembers the host key the first time. If it later changes, the connection is refused with a warning. If the change is expected, remove the SSH settings and add them again.
- Passwords and private keys are stored encrypted, the same as database passwords.

Connections from `powview.yaml` use an `ssh` block. Choose exactly one login method: `password_env`, `private_key_file` (a path inside the container, read when the connection opens), or `private_key_env`.

```yaml
connections:
  - id: prod
    name: Production
    url: postgresql://app_ro@localhost:5432/app # localhost as seen from the SSH server
    ssh:
      host: bastion.example.com
      port: 22 # optional, default 22
      user: deploy
      private_key_file: /run/secrets/bastion_key # file mounted as a read-only volume
      passphrase_env: BASTION_KEY_PASS # optional, for a key with a passphrase
      host_key: SHA256:abc123... # optional, pinned host key fingerprint
```

Mount the key file in your `compose.yml`:

```yaml
volumes:
  - ./secrets/bastion_key:/run/secrets/bastion_key:ro
```

From the CLI, outside the container (with `POWVIEW_URL` and `POWVIEW_TOKEN`, or the local key):

```bash
powview conn add postgresql://app_ro@localhost:5432/app --name Prod \
  --ssh deploy@bastion.example.com:22 --ssh-key ~/.ssh/bastion_ed25519

# SSH password from stdin
printf '%s' "$BASTION_PW" | powview conn add postgresql://app_ro@localhost:5432/app --name Prod \
  --ssh deploy@bastion.example.com --ssh-password-stdin

# change the tunnel without changing the secret, or remove it
powview conn edit Prod --ssh deploy@bastion2.example.com
powview conn edit Prod --no-ssh
```

`--ssh-key` reads a file on the machine where the CLI runs. `--ssh-password-stdin` cannot be used together with `--password-stdin`. Inside a container, `docker exec` can only read files inside that container.

## Production mode

Mark a connection as production with the **Production** switch in the connection dialog, with `--production` in the CLI, or with `production: true` in `powview.yaml`. On a production connection:

- A red **Production** badge shows in the connection list, the sidebar switcher, and the workspace header. A red line runs along the top of the work area.
- Every change asks you to confirm first. This covers saving grid changes (including added or deleted rows), changing a table's structure, sidebar actions such as drop and truncate, SQL that changes data, and CSV import.
- Risky changes need you to type the database name before the confirm button turns on. Risky means DROP, TRUNCATE, DELETE or UPDATE without `WHERE`, or deleting more than 10 rows in the grid.
- Read queries (SELECT, SHOW, EXPLAIN without ANALYZE, and similar) never ask for confirmation.

Production mode is a check in the app. It is not a security boundary. Also use a database account with limited rights, and use read-only for connections that must never change.

## Login and admin account

The first time pow/view starts with no admin, it opens the `/setup` page and asks for a username and a password (at least 8 characters). After that, sign in on the `/login` page. A sign-in lasts `POWVIEW_SESSION_DAYS` days (default 30).

- **Admin from environment**: if `POWVIEW_ADMIN_PASSWORD` is set and no admin exists, the admin is created at start. The username comes from `POWVIEW_ADMIN_USER` (default `admin`). In `compose.yml`, put these variables under `environment` of the `app` service.
- **Forgot the password**: run `docker exec -it powview powview admin reset-password`. The command asks for the new password twice and does not show what you type. For scripts, use `--password-stdin`. A reset also signs out every session. Without Docker, run `powview admin reset-password` where `POWVIEW_DATA_DIR` points to the data folder.
- **Change the password or sign out**: Settings, then Account.
- **Turn login off**: `POWVIEW_AUTH=off`. Only for trusted local use.
- **Login attempt limit**: 10 failed sign-ins in 15 minutes from one IP address block that address for a while.

## Network security and proxy

pow/view is built for **local use**. It can run any SQL with the credentials you saved, so:

- **Listen on `127.0.0.1`** (the default, and the port mapping in `compose.yml`). If other machines must reach pow/view, put it behind a reverse proxy with HTTPS, and set `POWVIEW_SECURE_COOKIES=true`.
- Behind a proxy, also set `POWVIEW_TRUST_PROXY=true`, so login limits use the real client IP. Do not turn this on if pow/view can be reached without the proxy, because `X-Forwarded-For` can be faked.
- **Allowed hosts**: pow/view refuses requests with an unknown `Host` header. This blocks DNS rebinding attacks. Add other host names with `POWVIEW_ALLOWED_HOSTS`.
- **Cross-site requests** are refused. A request that carries the session cookie must send `Content-Type: application/json`, which a cross-site form cannot send.
- **Password encryption**: saved connection passwords are encrypted with AES-256-GCM in `connections.json`. The key is `encryption.key` in the data folder (permission `0600`), unless `POWVIEW_SECRET` is set. On a server, set `POWVIEW_SECRET` (at least 16 characters) and keep it outside the data volume. If the key is lost, or `POWVIEW_SECRET` changes, saved passwords must be entered again. A password that is still plain text is never used, so save it again in the app.
- The local key in `auth.json` gives full access. Keep the data folder private (permission `0600`) and do not share it.

## Databases on your machine and other containers

Inside a container, `localhost` is the container itself. For a database running on your computer:

- Use the host name `host.docker.internal`, for example `postgresql://user:pass@host.docker.internal:5432/db_name`.
- The database must listen on `0.0.0.0` or on the Docker bridge address, not only on `127.0.0.1`.
- For a database in another container, use a port published through `host.docker.internal`, or connect both containers to the same Docker network.
- The development stack (`docker-compose.yml`) uses the demo database (`postgres:5432`). Run either that stack or `bun run demo:db`, not both. See [Development](development.md#demo-database).

## File size limits

| Type             | Default | Variable                 |
| ---------------- | ------- | ------------------------ |
| CSV import       | 200 MB  | `POWVIEW_MAX_IMPORT_MB`  |
| Database restore | 2048 MB | `POWVIEW_MAX_RESTORE_MB` |

The server accepts request bodies up to the larger of these two values. Invalid values fall back to the defaults above.
