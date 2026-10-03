# One recipe for both Node services:
#   docker build -f docker/node-app.Dockerfile --build-arg APP=api    -t clausecite-api .
#   docker build -f docker/node-app.Dockerfile --build-arg APP=worker -t clausecite-worker .
# Build context is the repository root.

# --- base: node + pnpm (the version pinned by `packageManager`, via corepack) ---
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    npm_config_store_dir=/pnpm/store \
    CI=true \
    TURBO_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# --- deps: download every locked package into the pnpm store (this layer is cached until the lockfile changes) ---
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

# --- build: install offline, compile the app and its workspace deps, then extract a prod-only tree ---
FROM deps AS build
ARG APP
RUN test -n "$APP" || (echo "build-arg APP is required (api|worker)" >&2; exit 1)
COPY . .
# argon2 (native) is the only dependency allowed to run build scripts (root `pnpm.onlyBuiltDependencies`).
RUN pnpm install --offline --frozen-lockfile
RUN pnpm turbo run build --filter=@clausecite/${APP}...
# `--legacy` copies workspace packages (core: dist + drizzle migrations) instead of requiring
# `inject-workspace-packages`; `--prod` drops devDependencies (and with them testcontainers).
RUN pnpm --filter @clausecite/${APP} deploy --legacy --prod /out

# --- runtime: no pnpm, no sources, no devDependencies, not root ---
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# The PDF volume mounts here; a named volume inherits this ownership on first use.
RUN mkdir -p /data/pdfs && chown -R node:node /data
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
USER node
CMD ["node", "dist/main.js"]
