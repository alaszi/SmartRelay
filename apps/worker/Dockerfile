# syntax=docker/dockerfile:1
# Same shape as apps/api/Dockerfile — see its comments for the rationale. Built from the repo
# root: `docker build -f apps/worker/Dockerfile .`

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
RUN pnpm --filter @smartrelay/worker build
RUN pnpm --filter @smartrelay/worker --prod deploy /app-deploy

FROM node:22-alpine AS runtime
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build --chown=app:app /app-deploy .
USER app
ENV NODE_ENV=production
CMD ["node", "dist/main.js"]
