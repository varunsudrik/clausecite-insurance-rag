#   docker build -f docker/web.Dockerfile -t clausecite-web .
# Build context is the repository root. The web image holds only the Next.js standalone server;
# `@clausecite/core` is a types-only devDependency of the web app, so none of its runtime ships.

# --- base: node + pnpm (the version pinned by `packageManager`, via corepack) ---
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    npm_config_store_dir=/pnpm/store \
    CI=true \
    TURBO_TELEMETRY_DISABLED=1 \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# --- deps: download every locked package into the pnpm store (this layer is cached until the lockfile changes) ---
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

# --- build ---
FROM deps AS build
# Inlined into the client bundle at build time. The default `/api` is the Caddy route to the API,
# so the browser stays same-origin (no CORS, CSP `connect-src 'self'`).
ARG NEXT_PUBLIC_API_URL=/api
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm turbo run build --filter=@clausecite/web...

# --- runtime ---
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
# `outputFileTracingRoot` is the repo root, so the standalone server lands at apps/web/server.js.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
