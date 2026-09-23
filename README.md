# SmartRelay

Event relay micro-SaaS for Romanian small businesses: receive a trigger, transform it, relay it to
SMS, HTTP, Telegram, Discord or Google Calendar, and bill a fractional pay-as-you-go credit per
successful delivery.

Scope and order of work: [MASTER_PLAN.md](MASTER_PLAN.md). Working rules: [CLAUDE.md](CLAUDE.md).
Security checklist evidence: [docs/SECURITY_CHECKLIST.md](docs/SECURITY_CHECKLIST.md).

## Requirements

- Node.js 22 or newer
- pnpm (pinned via `packageManager`; `corepack enable` provides it)
- Docker (dev services: Postgres, Redis, Mailpit)

## Getting started (development)

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

## Environment variables

All variables are Zod-validated at startup (`packages/shared/src/env.ts`); the process exits with a
list of problems if any is missing or malformed. Full reference in [.env.example](.env.example).

| Variable                                                            | Required        | Notes                                                                                                                                                                         |
| ------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                          | yes             | `development` locally, `production` in the deployed stack.                                                                                                                    |
| `APP_URL`                                                           | yes             | Public origin. Also the CSRF same-origin check's allowed origin and the Google OAuth redirect base.                                                                           |
| `INBOUND_DOMAIN`                                                    | yes             | Domain used to build inbound-email addresses (Module 2).                                                                                                                      |
| `API_PORT`                                                          | dev only        | Port the api process listens on directly; unused in production (Nginx fronts it).                                                                                             |
| `DATABASE_URL`, `REDIS_URL`                                         | yes             | In production these are set by `docker-compose.prod.yml`, not `.env` — don't set them there.                                                                                  |
| `SESSION_SECRET`                                                    | yes             | Any 32+ character string.                                                                                                                                                     |
| `ENCRYPTION_KEY`, `ENCRYPTION_KEY_ID`, `ENCRYPTION_KEYS_PREVIOUS`   | yes             | AES-256-GCM key for `relays.config_secret` / `oauth_connections.refresh_token`. See the rotation note in `.env.example` — losing this key makes stored secrets unrecoverable. |
| `MAIL_FROM`, `MAIL_PROVIDER`, `SMTP_URL` or `POSTMARK_SERVER_TOKEN` | yes             | Outbound email (verification, receipts).                                                                                                                                      |
| `INBOUND_EMAIL_PROVIDER`, `INBOUND_EMAIL_SECRET`                    | yes             | Module 2 (email-to-relay).                                                                                                                                                    |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`                        | production only | Billing. Optional in dev — billing routes no-op without them.                                                                                                                 |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                          | production only | Module 4 (Calendar bridge). Optional in dev.                                                                                                                                  |
| `WHATSAPP_ENABLED`                                                  | yes             | `false` — WhatsApp is out of scope (MASTER_PLAN decisions table).                                                                                                             |
| `TRUST_CLOUDFLARE`                                                  | yes             | See the caveat below — currently has no effect on IP attribution.                                                                                                             |
| `SENTRY_DSN`                                                        | no              | Optional error reporting.                                                                                                                                                     |
| `POSTGRES_PASSWORD`                                                 | production only | Read by `docker-compose.prod.yml` for the `postgres` and `api`/`worker`/`migrate` `DATABASE_URL`.                                                                             |

### `TRUST_CLOUDFLARE` caveat (found during Phase 6 load testing)

MASTER_PLAN section 3 says: "Assume Cloudflare may sit in front: trust `CF-Connecting-IP` only from
Cloudflare ranges, otherwise use the socket address." That range-validated trust was never
implemented in any phase. What's actually in `apps/api/src/app.ts` as of Phase 6 is `trustProxy:
(_, hop) => hop === 0` — Fastify always trusts exactly the immediate hop (Nginx, which always fronts
`api` in this deployment) and takes the client IP Nginx itself observed and appended, ignoring
anything a client tries to prepend into `X-Forwarded-For`. This is what per-IP rate limiting is keyed
on. It's correct and safe for the plain "Nginx only, no CDN" deployment this repo ships, and it's
what fixed a real bug found during the load test (every request was previously colliding on Nginx's
own container IP, collapsing the abuse-prevention rate limit into one sitewide bucket). It does
**not** implement Cloudflare-range validation of `CF-Connecting-IP` — if Cloudflare is ever put in
front of Nginx, that's still open work: fetch Cloudflare's current IP list
(<https://www.cloudflare.com/ips/>) and validate the hop before Nginx against it rather than trusting
it unconditionally.

## Stripe setup

1. Create a Stripe account (or use a test-mode one for staging) and copy the secret key into
   `STRIPE_SECRET_KEY`.
2. Add a webhook endpoint pointing at `<APP_URL>/api/webhooks/stripe`, subscribed at minimum to
   `checkout.session.completed`. Copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
3. Checkout sessions are created by `POST /api/billing/checkout` (packages/engine's
   `PaymentProvider` abstraction, `packages/engine/src/payment-provider.ts`); the webhook credits the
   ledger and releases any events that were held for insufficient balance.

## Google Calendar setup (Module 4)

1. In Google Cloud Console, create an OAuth 2.0 Client ID (Web application).
2. Add `<APP_URL>/api/oauth/google/callback` as an authorized redirect URI.
3. Copy the client id/secret into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
4. Requested scopes (least-privilege, `packages/engine/src/google-calendar.ts`):
   `calendar.events` (create/update calendar events) and `userinfo.email` (label the connection by
   account email only — no elevated access). `access_type=offline` + `prompt=consent` are used so a
   `refresh_token` is always returned, even on a repeat consent.
5. The stored `refresh_token` is AES-256-GCM encrypted the same way as `relays.config_secret`
   (`packages/engine/src/crypto.ts`, AAD-bound per row).

## Inbound email setup (Module 2)

1. `INBOUND_EMAIL_PROVIDER=postmark` is the only implemented provider. Configure Postmark's inbound
   webhook to POST to `<APP_URL>/inbound/email/postmark`.
2. Set `INBOUND_EMAIL_SECRET` to a value only you and Postmark know, and configure Postmark to send
   it (query param or header per your Postmark inbound setup) — the route rejects requests where it
   doesn't match.

## Production deployment

```bash
cp .env.example .env   # fill in real secrets; also set POSTGRES_PASSWORD
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d postgres redis
docker compose -f docker-compose.prod.yml run --rm migrate   # migrates AND seeds pricing
docker compose -f docker-compose.prod.yml up -d
```

This is what [deploy/deploy.sh](deploy/deploy.sh) does, run on the VPS over SSH by the manual-only
[.github/workflows/deploy.yml](.github/workflows/deploy.yml) (`workflow_dispatch`, gated on
`DEPLOY_HOST`/`DEPLOY_USER`/`DEPLOY_SSH_KEY` repo secrets — pushing to `main` never deploys, per
MASTER_PLAN decision D8). Nginx ([deploy/nginx.smartrelay.conf](deploy/nginx.smartrelay.conf)) is the
single public entry point, routing `/`, `/api/*`, `/i/*`, `/inbound/*`, `/tg/*`, `/healthz`,
`/readyz` to `web` or `api` so the app is same-origin (cookies, CSRF Origin check work without a
cross-origin exception).

No image registry or CI image-publish pipeline exists — images are built from source on the VPS
itself on every deploy. Adding one later is a case of adding `image:` tags to
`docker-compose.prod.yml` and swapping `deploy.sh`'s `build` call for a `pull`.

Verified end-to-end during Phase 6 (a full `docker compose -f docker-compose.prod.yml up` stack:
register → verify email → login → create a relay → ingest an event held for zero balance → credit
via `admin:credit` → ingest again → worker delivers → `SUCCESS` recorded), including through the
actual Nginx-fronted entry point rather than hitting `api` directly.

### Admin credit adjustments

```bash
pnpm admin:credit --email user@example.com --amount 5.00 --reason "goodwill credit" [--kind adjustment|refund|chargeback]
```

Runs against `DATABASE_URL` from `.env`. Idempotency key is a fresh `admin:<uuid>` per run, so
re-running it for the same reason credits again rather than silently no-op'ing — don't re-run it
by accident.

## Load test

100 req/s sustained ingest, measured against the real production Docker stack (not dev mode), through
Nginx, on this development machine (not a VPS — see caveat below):

```
100 concurrent tokens (25 relays × 4 users), ~1 req/s each → 100 req/s aggregate
3000/3000 requests succeeded, 0 errors, 0 timeouts
duration: 30.3s, avg throughput: ~99 req/s
latency: p50 10ms · p90 19ms · p97.5 26ms · p99 31ms · max 62ms
```

p95 latency is comfortably under the 200ms target (interpolating between the measured p90/p97.5, it's
in the ~20ms range). **Methodology note:** `apps/api/src/routes/ingest.ts` rate-limits each ingest
token to 120 requests/minute, and a separate loop-detection guard rejects repeated identical request
bodies — both real, load-test-encountered guardrails. The test therefore spreads load across 100
distinct relay tokens (one per token, ~1 req/s each) with a randomized body per request, rather than
hammering a single token, which mirrors how 100 req/s would actually arrive in production (many
customers, not one customer sending 100 events/s). A single real-world load generator would also be
capped by the global per-IP limiter (300 req/min, `apps/api/src/app.ts`) — this test's traffic all
originates from one machine, same as it would from a single-source VPS load-testing tool, and stayed
under that limit at the tested rate. autocannon was added as a root dev dependency
(`pnpm add -Dw autocannon`) for this; there's no permanently committed load-test script since the
per-run setup (registering test users, creating relays for fresh tokens) is one-off scaffolding, not
part of the app itself.

## Backups

Postgres is the source of truth; Redis is treated as rebuildable (on worker start, `QUEUED`/`HELD`
events and pending reminders with no live job are re-enqueued from the DB — see
`reenqueueStuckEvents` in `apps/worker`).

```bash
# Daily backup, e.g. via cron on the VPS (adjust retention as needed):
docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U smartrelay smartrelay \
  | gzip > /opt/smartrelay/backups/smartrelay-$(date +%F).sql.gz

# Restore (stop api/worker first so nothing writes during restore):
docker compose -f docker-compose.prod.yml stop api worker
gunzip -c /opt/smartrelay/backups/smartrelay-YYYY-MM-DD.sql.gz \
  | docker compose -f docker-compose.prod.yml exec -T postgres psql -U smartrelay smartrelay
docker compose -f docker-compose.prod.yml start api worker
```

## Runbook

**Stuck queue (events not being delivered):**

1. Check the worker is actually running: `docker compose -f docker-compose.prod.yml ps worker` and
   `docker compose -f docker-compose.prod.yml logs worker --tail 100`.
2. Check Redis is healthy: `docker compose -f docker-compose.prod.yml exec redis redis-cli ping`.
3. If Redis was lost/flushed, restarting the worker re-enqueues any `QUEUED`/`HELD` DB rows
   automatically (`reenqueueStuckEvents`) — no manual event-by-event recovery needed.
4. Check for a specific failing relay: query `events` by `status` and `relay_id` (see
   `context`-equivalent queries in `packages/db`) to see if failures cluster on one relay (bad
   webhook URL, expired OAuth token, etc.) versus system-wide.

**Refunds:**

```bash
pnpm admin:credit --email user@example.com --amount 2.50 --reason "refund: <ticket/reason>" --kind refund
```

Use `--kind chargeback` (negative-amount semantics — see `scripts/admin-credit.ts`) for a chargeback
deduction instead. Every adjustment is a ledger entry with its own idempotency key, so history stays
auditable — never edit balances directly in the database.

## Known deviations from MASTER_PLAN (tracked against section 15's acceptance checklist)

- **Telegram inline buttons** (Module 1, chat_relay): deferred. Text templates and plain links work;
  interactive buttons are not implemented.
- **`TRUST_CLOUDFLARE` / Cloudflare IP-range validation**: see the environment variable caveat above
  — the env var is currently unused; a real Cloudflare-range check is still open work if Cloudflare
  is ever put in front of this deployment.
