# Install and update

How to run PowDBs with npx or Docker, where your data is kept, and how to update. For settings, see [Configuration](configuration.md). To build from source, see [Development](development.md).

## Run with npx

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npx powdbs          # or: bunx powdbs
npx powdbs --yes    # installs Bun without asking, for scripts
```

- PowDBs runs on [Bun](https://bun.sh). If Bun is missing or older than 1.4.4, `powdbs` says so and asks whether to install Bun 1.4.4. That copy goes only into `~/.powdbs/runtime`. Nothing else on your computer changes. Answer `n` to install Bun yourself from https://bun.sh instead. Without a terminal, `powdbs` installs Bun only when you pass `--yes`.
- Your connections, account, tokens, and logs are kept in `~/.powdbs`. Change the folder with `--data-dir <path>` or `POWDBS_DATA_DIR`.
- Options: `--port <n>`, `--host <address>`, `--data-dir <path>`, `--no-open` (do not open the browser), and `-y` or `--yes`. Run `powdbs --help` for the list.
- Other commands, such as `powdbs status` or `powdbs dump`, use the admin CLI. Run `powdbs help` to see them.

### PostgreSQL client tools

Backups and restores need `pg_dump`, `pg_restore`, and `psql`, version 14 or newer (18 recommended). If they are missing, `powdbs` says so when it starts. Everything else works without them. The notice shows how to install them. `powdbs` never installs them for you.

If they are installed somewhere else, set `POWDBS_PG_DUMP` to the `pg_dump` path, and `POWDBS_PG_BIN` to the folder that holds `psql` and `pg_restore`. The Docker image already includes all three.

## Run with Docker

You need [Docker](https://docs.docker.com/get-docker/).

```bash
docker run -d --name powdbs -p 127.0.0.1:3333:3333 -v powdbs-data:/data \
  --add-host host.docker.internal:host-gateway ghcr.io/powroom/powdbs:latest
```

- The port is bound to `127.0.0.1`, so only this computer can reach PowDBs.
- Your connections, account, tokens, and logs are saved in the `powdbs-data` volume. They stay after a restart.
- `--add-host` lets PowDBs reach databases on your computer through `host.docker.internal`.
- The image works on amd64 and arm64, including Apple Silicon Macs.
- The image layers use zstd compression for a smaller download, so pulling it needs Docker 23 or newer (or Podman 4, containerd 1.5).

## Docker Compose

Download the example file and start it:

```bash
curl -o compose.yml https://raw.githubusercontent.com/powroom/powdbs/main/compose.example.yml
docker compose up -d
docker compose logs -f app   # show app logs (Ctrl+C to stop)
docker compose down          # stop (the data volume stays)
```

The file has commented examples for the admin password, connections created at first start, and a `powdbs.yaml` file.

## Pin a version

Use a version tag, such as `ghcr.io/powroom/powdbs:0.1.0`, instead of `latest`.

## Update

Once a day, PowDBs checks for a new release. When one is out, a notice appears at the bottom of the sidebar. Click it to read the release notes and see the steps for your install. Settings > General shows your version too. To turn the check off, set `POWDBS_UPDATE_CHECK=off` (see [Configuration](configuration.md#environment-variables)).

- **Docker:** pull the new image, then recreate the container. Your data stays in the volume:

  ```bash
  docker pull ghcr.io/powroom/powdbs:latest
  docker rm -f powdbs     # then run the docker run command above again
  ```

  With Compose, run `docker compose pull && docker compose up -d` instead.

- **npx:** stop PowDBs (Ctrl+C), then run `npx powdbs@latest` to get the newest release. `bunx powdbs@latest` works too. Your data in `~/.powdbs` stays.
- **Source:** in your PowDBs folder, run `git pull`, `bun install`, and `bun run build`, then restart PowDBs.
