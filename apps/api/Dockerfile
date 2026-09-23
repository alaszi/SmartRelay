# syntax=docker/dockerfile:1
# Multi-stage build for a pnpm workspace: `deps` installs everything once, `build` compiles this
# one app and produces a self-contained runtime tree via `pnpm deploy`, `runtime` is the minimal,
# non-root final image. Built from the repo root: `docker build -f apps/api/Dockerfile .`
# (docker-compose.prod.yml's `context: .` does this).

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

# --- deps: install once, cached as long as lockfile + every package.json are unchanged ---
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/engine/package.json packages/engine/package.json
COPY packages/db/package.json packages/db/package.json
COPY scripts/package.json scripts/package.json
RUN pnpm install --frozen-lockfile

# --- build: full workspace source, compiles apps/api, still has tsx/pnpm for `docker compose run
# migrate` (docker-compose.prod.yml targets this stage directly for that, not the final image) ---
FROM deps AS build
COPY . .
RUN pnpm --filter @smartrelay/api build
# A pruned, standalone copy (workspace deps resolved into a real node_modules, no symlinks outside
# it) — this is what actually ships in the runtime stage below.
RUN pnpm --filter @smartrelay/api --prod deploy /app-deploy

# --- runtime: only the pruned app, non-root ---
FROM node:22-alpine AS runtime
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build --chown=app:app /app-deploy .
USER app
ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "dist/main.js"]
