# SmartRelay

Event relay micro-SaaS for Romanian small businesses: receive a trigger, transform it, relay it to
SMS, HTTP, Telegram, Discord or Google Calendar, and bill a fractional pay-as-you-go credit per
successful delivery.

Scope and order of work: [MASTER_PLAN.md](MASTER_PLAN.md). Working rules: [CLAUDE.md](CLAUDE.md).

## Requirements

- Node.js 22 or newer
- pnpm (pinned via `packageManager`; `corepack enable` provides it)
- Docker (dev services: Postgres, Redis, Mailpit)

## Getting started

```bash
cp .env.example .env
docker compose up -d
pnpm install
pnpm build
```

Checks that must pass before every commit:

```bash
pnpm typecheck && pnpm lint && pnpm test
```

`pnpm test` includes integration tests that need the dev Postgres (`docker compose up -d --wait`).
They create and use a separate `smartrelay_test` database, never the dev one.

Database commands (need `DATABASE_URL`, read from `.env`):

```bash
pnpm db:migrate   # apply migrations
pnpm db:seed      # seed default prices (existing prices are never overwritten)
```

The full README (env reference, Stripe/Google/inbound-email setup, backups, runbook) is written in
Phase 6.
