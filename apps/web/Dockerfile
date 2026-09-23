# syntax=docker/dockerfile:1
# Same deps/build shape as apps/api/Dockerfile, but the runtime stage ships Next's own
# `output: 'standalone'` tree instead of `pnpm deploy` (see next.config.ts). Built from the repo
# root: `docker build -f apps/web/Dockerfile .`

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

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

FROM deps AS build
COPY . .
RUN pnpm --filter @smartrelay/web build
# The standalone server doesn't copy these itself (Next's docs: intended for a CDN instead) —
# there is no CDN here, so Nginx/the app itself must be able to serve them. public/ is optional.
RUN if [ -d apps/web/public ]; then cp -r apps/web/public apps/web/.next/standalone/apps/web/public; fi \
  && cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static

# --- runtime: only the traced standalone tree, non-root ---
FROM node:22-alpine AS runtime
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
# outputFileTracingRoot is the monorepo root, so the traced tree nests under apps/web/ (its path
# there) alongside a shared node_modules at the tree's root — copy the whole thing as one unit.
COPY --from=build --chown=app:app /repo/apps/web/.next/standalone ./
USER app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
