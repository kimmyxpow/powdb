# Install and update

How to run pow/view with npx or Docker, where your data is kept, and how to update. For settings, see [Configuration](configuration.md). To build from source, see [Development](development.md).

## Run with npx

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npx powview          # or: bunx powview
npx powview --yes    # installs Bun without asking, for scripts
```

- pow/view runs on [Bun](https://bun.sh). If Bun is missing or older than 1.4.4, `powview` says so and asks whether to install Bun 1.4.4. That copy goes only into `~/.powview/runtime`. Nothing else on your computer changes. Answer `n` to install Bun yourself from https://bun.sh instead. Without a terminal, `powview` installs Bun only when you pass `--yes`.
- Your connections, account, tokens, and logs are kept in `~/.powview`. Change the folder with `--data-dir <path>` or `POWVIEW_DATA_DIR`.
- Options: `--port <n>`, `--host <address>`, `--data-dir <path>`, `--no-open` (do not open the browser), and `-y` or `--yes`. Run `powview --help` for the list.
- Other commands, such as `powview status` or `powview dump`, use the admin CLI. Run `powview help` to see them.

### PostgreSQL client tools

Backups and restores need `pg_dump`, `pg_restore`, and `psql`, version 14 or newer (18 recommended). If they are missing, `powview` says so when it starts. Everything else works without them. The notice shows how to install them. `powview` never installs them for you.

If they are installed somewhere else, set `POWVIEW_PG_DUMP` to the `pg_dump` path, and `POWVIEW_PG_BIN` to the folder that holds `psql` and `pg_restore`. The Docker image already includes all three.

## Run with Docker

You need [Docker](https://docs.docker.com/get-docker/).

```bash
docker run -d --name powview --restart unless-stopped -p 127.0.0.1:3333:3333 -v powview-data:/data \
  --add-host host.docker.internal:host-gateway ghcr.io/powroom/powview:latest
```

- The port is bound to `127.0.0.1`, so only this computer can reach pow/view.
- `--restart unless-stopped` starts pow/view again after a reboot or a Docker restart, unless you stopped it yourself with `docker stop powview`. Already running without it? Add it with `docker update --restart unless-stopped powview`.
- Your connections, account, tokens, and logs are saved in the `powview-data` volume. They stay after a restart.
- `--add-host` lets pow/view reach databases on your computer through `host.docker.internal`.
- The image works on amd64 and arm64, including Apple Silicon Macs.
- The image layers use zstd compression for a smaller download, so pulling it needs Docker 23 or newer (or Podman 4, containerd 1.5).

## Docker Compose

Download the example file and start it:

```bash
curl -o compose.yml https://raw.githubusercontent.com/powroom/powview/main/compose.example.yml
docker compose up -d
docker compose logs -f app   # show app logs (Ctrl+C to stop)
docker compose down          # stop (the data volume stays)
```

The file has commented examples for the admin password, connections created at first start, and a `powview.yaml` file.

## Pin a version

Use a version tag, such as `ghcr.io/powroom/powview:0.1.0`, instead of `latest`.

## Update

Once a day, pow/view checks for a new release. When one is out, a notice appears at the bottom of the sidebar. Click it to read the release notes and see the steps for your install. Settings > General shows your version too. To turn the check off, set `POWVIEW_UPDATE_CHECK=off` (see [Configuration](configuration.md#environment-variables)).

- **Docker:** pull the new image, then recreate the container. Your data stays in the volume:

  ```bash
  docker pull ghcr.io/powroom/powview:latest
  docker rm -f powview     # then run the docker run command above again
  ```

  With Compose, run `docker compose pull && docker compose up -d` instead.

- **npx:** stop pow/view (Ctrl+C), then run `npx powview@latest` to get the newest release. `bunx powview@latest` works too. Your data in `~/.powview` stays.
- **Source:** in your pow/view folder, run `git pull`, `bun install`, and `bun run build`, then restart pow/view.
