# syntax=docker/dockerfile:1

# ---- build: client, fully bundled server, CLI -------------------------------------------------
# The server build bundles every dependency (vite.config.ts: ssr.noExternal), so the runtime
# image needs no node_modules at all.
# This stage runs on the build machine's CPU ($BUILDPLATFORM), even for an arm64 image. Its output
# is plain JavaScript and static files, the same for every CPU, so nothing native is copied over.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.4-slim AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build \
  # server.ts imports app code (#/lib/...): bundle it too, so the image needs no src/ or package.json
  && bun build server.ts --target bun --minify --outfile start.js \
  # the CLI runs straight from the kernel (no shell in the runtime image)
  && sed -i '1i #!/usr/local/bin/bun' dist/cli/powdb.js \
  && chmod 0755 dist/cli/powdb.js \
  # the data directory, created here because the runtime image has no shell
  && mkdir -p /out/data

# ---- PostgreSQL 18 client tools ---------------------------------------------------------------
# pg_dump, pg_restore and psql 18 (they work with servers 14 to 18), from the PostgreSQL apt
# repository with the signing key checked by fingerprint. Only the three programs and the shared
# libraries they load are copied to the runtime image (the package pulls in Perl and more).
FROM debian:trixie-slim AS pgtools
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gpg; \
    . /etc/os-release; \
    install -d /usr/share/postgresql-common/pgdg; \
    curl -fsSL --output /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc; \
    gpg --show-keys --with-colons /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
      | awk -F: '$1 == "fpr" { print $10; exit }' \
      | grep -qx 'B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8'; \
    printf '%s\n' \
      'Types: deb' \
      'URIs: https://apt.postgresql.org/pub/repos/apt' \
      "Suites: ${VERSION_CODENAME}-pgdg" \
      'Components: main' \
      'Signed-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc' \
      > /etc/apt/sources.list.d/pgdg.sources; \
    apt-get update; \
    apt-get install -y --no-install-recommends postgresql-client-18; \
    bin=/usr/lib/postgresql/18/bin; \
    # /lib is a link to /usr/lib in the runtime image, so libraries go to the real directory
    libdir=/usr/lib/$(uname -m)-linux-gnu; \
    mkdir -p /out$bin /out$libdir; \
    for tool in pg_dump pg_restore psql; do cp $bin/$tool /out$bin/; done; \
    # every shared library they need, except glibc itself (the runtime image has the same one)
    for tool in pg_dump pg_restore psql; do ldd $bin/$tool; done \
      | awk '$3 ~ /^\// { print $3 }' | sort -u \
      | grep -vE '/(libc|libm|libpthread|libdl|ld-linux[^/]*)\.so' \
      | while read -r lib; do cp -L "$lib" /out$libdir/; done; \
    /out$bin/pg_dump --version

# ---- runtime: Bun on distroless (no shell, no package manager) ---------------------------------
FROM oven/bun:1.4.4-distroless AS runtime
WORKDIR /app

LABEL org.opencontainers.image.source="https://github.com/kimmyxpow/powdb" \
      org.opencontainers.image.title="PowDB" \
      org.opencontainers.image.description="A web app for browsing and managing PostgreSQL databases." \
      org.opencontainers.image.url="https://github.com/kimmyxpow/powdb" \
      org.opencontainers.image.licenses="Apache-2.0"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3333 \
    POWDB_DATA_DIR=/data \
    POWDB_INSTALL=docker \
    POWDB_PG_DUMP=/usr/lib/postgresql/18/bin/pg_dump

COPY --from=pgtools /out/ /
COPY --from=build --chown=1000:1000 /out/data /data
COPY --from=build /app/dist ./dist
COPY --from=build /app/start.js ./
COPY LICENSE NOTICE ./
# `powdb` CLI (talks to the running server; reads /data/auth.json)
COPY --from=build /app/dist/cli/powdb.js /usr/local/bin/powdb

# uid 1000 matches the bun user, so a /data folder owned by uid 1000 (for example a bind mount) works
USER 1000:1000
VOLUME ["/data"]

EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3333) + '/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

ENTRYPOINT []
CMD ["bun", "start.js"]
