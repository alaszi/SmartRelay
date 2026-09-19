# SmartRelay.ro: Codebase Master Plan (for Claude Code)

> Read this file fully before writing any code. Then read `CLAUDE.md` (working rules).
> Milestone target: **all 4 modules working end to end** (Webhook→SMS, Email→API, Telegram/Discord, Calendar Bridge), with credits, billing (Stripe), logs, retries, and GDPR retention.
> Production host is **not decided**. Everything must run in Docker on a plain VPS and stay swappable. Nothing may assume FTP/shared hosting.

---

## 0. Product in one paragraph

SmartRelay receives a trigger (HTTP POST, inbound email, bot callback), extracts/transforms data with JSONPath + templates, forwards it to a destination (SMS, HTTP endpoint, Telegram, Discord, Google Calendar), and bills a fractional pay-as-you-go credit for each **successful** delivery. Audience: Romanian (and HU-speaking) small businesses. Positioning: *"The simplest API bridge and SMS/webhook gateway for Romanian web shops and small businesses."* It is **not** a general no-code automation builder.

### Non-goals (do not build)
- No flow diagrams, drag-and-drop builders, multi-step workflows, or conditional branching.
- No extra screens beyond the 4 app screens (plus login/register/verify auth pages).
- No admin UI (use CLI scripts, section 12), no teams/multi-user, no monthly plans.
- None of the roadmap modules (IoT, e-Factura, gateway switcher, AI proxy, image relay, status relay).
- No WhatsApp in the UI yet (feature flag off, section 9).

---

## 1. Decisions (defaults are final unless the owner changes them)

| ID | Topic | Default decision |
|----|-------|------------------|
| D1 | SMS billing mode | **BYO provider key.** User enters their own SMS provider credentials, the provider bills them directly, SmartRelay charges only its **€0.025** fee per SMS. The "+ provider cost" mode (SmartRelay's own provider account, pass-through cost) is designed for (`sms_mode` column) but **not built**. |
| D2 | SMS providers v1 | SMSLink + Twilio implemented; Infobip as a typed stub. Netopia is **not** an SMS provider (payments only). |
| D3 | WhatsApp | Hidden behind `WHATSAPP_ENABLED=false`. Adapter interface exists; no UI, no billing until provider approval is verified. |
| D4 | Calendar | Google Calendar only in v1. iCal/Apple = later. |
| D5 | Telegram buttons | URL buttons fully supported. `callback_data` buttons are sent, and the callback is logged as an inbound event and acknowledged (`answerCallbackQuery`); no further forwarding in v1. |
| D6 | Billing provider | Stripe Checkout behind a `PaymentProvider` interface (Netopia can be added later). Credit = gross amount paid. |
| D7 | Notifications | Email only in v1 (SMS notification to the account owner = later). |
| D8 | Deployment | Docker images per app + `docker-compose.prod.yml` + Nginx sample + SSH deploy script. GitHub Actions deploy workflow ships as **manual-only** (`workflow_dispatch`) until the owner picks a host. |
| D9 | Test button | Performs a **real** delivery, is billed normally, and is flagged `source=test` in logs. The UI states the cost before sending. |
| D10 | UI language | English strings via `next-intl`, catalogs structured so `ro` and `hu` can be added without refactoring. |
| D11 | Negative balance | New events are held when `balance < price of this action`. In-flight jobs may push the balance slightly below zero (a few cents); accept that. |

Owner-only items (not Claude Code tasks, mention them in the final report): Stripe account + keys, Postmark (or chosen inbound-email provider) account and MX/DNS, Google Cloud OAuth client (see section 10), SMS provider test accounts, VAT/invoicing treatment of prepaid credits (ask the accountant), hosting choice.

---

## 2. Tech stack

| Layer | Choice |
|-------|--------|
| Monorepo | pnpm workspaces, TypeScript (strict), Node 22 LTS |
| Web | Next.js (App Router), Tailwind CSS, shadcn/ui, Lucide, react-hook-form + zod, next-intl |
| API | Fastify 5, zod (via `fastify-type-provider-zod`), `@fastify/rate-limit`, `@fastify/cookie`, pino |
| Worker | BullMQ on Redis |
| DB | PostgreSQL 16, **Drizzle ORM** + drizzle-kit migrations |
| Engine libs | `jsonpath-plus` (eval disabled/safe mode), `libphonenumber-js`, `luxon` (timezones) |
| Auth | API-owned sessions in Postgres, httpOnly SameSite=Lax cookie, `@node-rs/argon2` |
| Payments | Stripe SDK (Checkout, one-time payments) |
| Email | Outbound: Postmark or SMTP (nodemailer) behind `Mailer` interface. Inbound: Postmark inbound webhook behind `InboundEmailAdapter` (Mailgun swappable). |
| Tests | vitest (unit + integration), msw for provider mocks, Playwright smoke test for the relay form |
| Quality | eslint, prettier, `tsc --noEmit` in CI |

Third-party APIs (SMSLink, Twilio, Postmark inbound, Stripe, Google Calendar, Telegram Bot API, Discord webhooks): **fetch the current official docs before implementing each one. Do not invent endpoints, fields or auth schemes.** If docs for a provider cannot be reached, implement the adapter against the interface with a clearly marked `TODO(verify-docs)` and a mock-backed test, and list it in the final report.

---

## 3. Repository layout

```
.
├── CLAUDE.md
├── MASTER_PLAN.md
├── README.md
├── package.json / pnpm-workspace.yaml / tsconfig.base.json
├── docker-compose.yml            # dev: postgres, redis, mailpit
├── docker-compose.prod.yml       # prod: web, api, worker, postgres, redis
├── .env.example
├── .github/workflows/
│   ├── ci.yml                    # lint, typecheck, test, build (PR + push)
│   └── deploy.yml                # workflow_dispatch ONLY, SSH deploy template
├── deploy/
│   ├── nginx.smartrelay.conf     # / -> web, /api and /i -> api, /inbound -> api
│   └── deploy.sh                 # ssh + docker compose pull/up + migrate
├── apps/
│   ├── web/                      # Next.js UI (no business logic)
│   ├── api/                      # Fastify: auth, relays CRUD, ingest, logs, billing, webhooks
│   └── worker/                   # BullMQ processors + maintenance jobs
├── packages/
│   ├── shared/                   # zod schemas, enums, types, price constants, error codes
│   ├── db/                       # drizzle schema, migrations, ledger + repo functions, seed
│   └── engine/                   # jsonpath, templates, modules (adapters), providers, crypto, ssrf, hmac
└── scripts/                      # admin CLI (credit adjust, user lookup), dev helpers
```

Rules: `apps/web` calls only the API. Business logic lives in `packages/engine` and `packages/db`, never in route handlers or React components. Same origin in production: Nginx routes `/` → web, `/api/*`, `/i/*`, `/inbound/*` → api (so cookies are same-origin). Assume Cloudflare may sit in front: trust `CF-Connecting-IP` only from Cloudflare ranges, otherwise use the socket address.

---

## 4. Data model (Drizzle, all ids `uuid`, timestamps `timestamptz`)

Money is stored as **bigint micro-euros** (1 EUR = 1,000,000). €0.005 = 5,000. Never use floats for money.

| Table | Key columns / notes |
|-------|---------------------|
| `users` | id, email (citext, unique), password_hash, email_verified_at, timezone (default `Europe/Bucharest`), created_at |
| `sessions` | id (random 256-bit, stored hashed), user_id, expires_at, created_at |
| `credit_accounts` | user_id (pk), balance_micro. Row-locked (`FOR UPDATE`) for every ledger write. |
| `credit_ledger` | id, user_id, delta_micro, kind (`topup`/`charge`/`adjustment`/`refund`), ref_type, ref_id, **idempotency_key (unique)**, balance_after_micro, created_at. Append-only. |
| `topups` | id, user_id, provider (`stripe`), provider_session_id (unique), amount_cents, status, created_at |
| `processed_provider_events` | provider, event_id (pk together): webhook idempotency |
| `pricing` | kind (pk: `relay_http`, `calendar_event`, `sms_dispatch`), price_micro. Seeded: 5000 / 10000 / 25000. |
| `relays` | id, user_id, name, type (`webhook_sms`/`email_api`/`chat_relay`/`calendar_bridge`), status (`active`/`inactive`), ingest_token (unique, 32+ chars base64url), config_public (jsonb, non-secret fields for display), config_secret (encrypted blob, section 8), sms_mode (`byo`/`managed`, default `byo`), created_at, updated_at, last_triggered_at |
| `relay_email_addresses` | relay_id (unique), address (unique, `r_<8 chars>@<INBOUND_DOMAIN>`) |
| `oauth_connections` | id, user_id, provider (`google`), account_email, refresh_token (encrypted), scopes, created_at |
| `events` | id, relay_id, user_id, source (`http`/`email`/`telegram_callback`/`test`), status (see below), dedupe_hash, held_until, cost_micro, final_status_code, error_code, received_at, finished_at |
| `event_payloads` | event_id (pk), payload_in, payload_out, response_excerpt (max 8 KB), purge_after (received_at + 30 days). **Only table holding user payload content.** |
| `delivery_attempts` | id, event_id, attempt_no, started_at, duration_ms, ok, status_code, error_code, error_message (no secrets) |
| `scheduled_reminders` | id, event_id, relay_id, run_at, status (`pending`/`sent`/`failed`/`cancelled`) |
| `notifications` | id, user_id, kind, dedupe_key (unique with user_id), sent_at |

Event status: `RECEIVED` → `QUEUED` → `PROCESSING` → `SUCCESS` | `FAILED`; side states: `HELD_NO_CREDIT`, `EXPIRED` (held > 48 h), `DROPPED_LOOP`, `REJECTED` (bad HMAC/size/inactive relay: not billed, not queued).

---

## 5. Core pipeline

```
Ingest (API, must return in <100 ms typical)
  1. Resolve relay by ingest token (or inbound email address). Unknown -> 404, inactive -> 409 logged.
  2. Enforce body limit (256 KB), content-type (JSON / form-urlencoded / text), per-token and per-IP rate limit.
  3. Optional HMAC validation (Advanced setting) on the RAW body. Fail -> REJECTED.
  4. Loop guard (section 7). Exceeded -> DROPPED_LOOP.
  5. Insert events + event_payloads. Credit check (balance >= price) else HELD_NO_CREDIT (section 7).
  6. Enqueue `deliver` job (jobId = event id). Respond 202 { eventId }.

Worker `deliver`
  1. Load relay, decrypt config, load payload.
  2. Run module.execute() (section 6). It is a pure adapter: no DB writes inside adapters.
  3. Record delivery_attempt.
  4. SUCCESS -> in ONE transaction: write ledger charge (idempotency_key = `charge:<eventId>`), update balance, set event SUCCESS + cost.
     Retryable failure -> BullMQ retry. Terminal failure or retries exhausted -> FAILED (not billed).
```

Retryable = network error, timeout, HTTP 5xx, 429 (honor `Retry-After` if larger than the backoff). Everything else (4xx other than 429, template/JSONPath errors, invalid phone) = terminal, no retry.
BullMQ: `attempts: 4` (initial + 3 retries), custom backoff strategy returning **1 min, 5 min, 15 min**.

### Module adapter contract (`packages/engine`)

```ts
interface RelayModule<TConfig> {
  type: RelayType;
  configSchema: z.ZodType<TConfig>;          // shared with web form validation
  priceKind(config: TConfig): PricingKind;
  execute(args: {
    config: TConfig;
    payload: unknown;                          // parsed inbound payload
    ctx: { eventId: string; userTimezone: string; http: SafeHttpClient; now: Date };
  }): Promise<
    | { ok: true; statusCode: number; request: unknown; response: unknown; extra?: Record<string, unknown> }
    | { ok: false; retryable: boolean; errorCode: string; message: string; statusCode?: number; request?: unknown; response?: unknown }
  >;
  sampleInput(): unknown;                      // used to prefill "Send Test Payload"
}
```

Adding a module later = one adapter + one form definition. Do not special-case module types in the pipeline.

### Template and path rules (`packages/engine`)
- Template syntax: `{{$.path.to.value}}` (JSONPath, first match). Whitespace inside braces tolerated.
- Missing/undefined variable → terminal error `TEMPLATE_VAR_MISSING` naming the path (never silently send "undefined").
- Objects/arrays render as JSON strings; numbers and booleans as plain text.
- Validate at save time: template parses, every path is valid JSONPath syntax. Validate against the sample payload in the test step.
- Never `eval`. Configure `jsonpath-plus` so script evaluation is disabled.

---

## 6. Modules (all four in this milestone)

Pricing kinds: `relay_http` €0.005 (Modules 2, 3), `calendar_event` €0.01 (Module 4), `sms_dispatch` €0.025 (Module 1, BYO mode). Only successful deliveries are billed.

### Module 1: Webhook → SMS (`webhook_sms`)
- Trigger: `POST https://<host>/i/<ingestToken>` with JSON payload.
- Required config: name, provider (`smslink` | `twilio` | `infobip`(stub)), API credentials (provider-specific fields, encrypted), `recipientPath` (JSONPath), `template`.
- Advanced (collapsed): HMAC validation (header name, secret, algorithm, encoding) with presets for **WooCommerce** (`X-WC-Webhook-Signature`, base64 HMAC-SHA256 of raw body) and **Shopify** (`X-Shopify-Hmac-Sha256`, base64); WhatsApp option only if `WHATSAPP_ENABLED`.
- Behavior: normalize the phone with `libphonenumber-js` (default region `RO`) to E.164; invalid number = terminal `INVALID_PHONE`. Render the template, warn (in test step) when GSM-7 segments exceed 1 and show segment count. Providers implement `SmsProvider { send(); }` behind the adapter.

### Module 2: Email → API Parser (`email_api`)
- Trigger: inbound email to `r_<8 chars>@<INBOUND_DOMAIN>` → `POST /inbound/email/<provider>` (authenticated by secret path or basic auth per the provider's docs; reject otherwise). Map recipient → relay. Unknown recipient → drop with 200 (avoid provider retry storms), log at info.
- Required config: name, auto-generated address (copy button), target webhook URL.
- Advanced: parsing rules (list of `{ name, type: 'jsonpath'|'regex', expression }`; regex uses named groups and runs against the text body), filter (subject contains / sender equals; non-matching mail = event `REJECTED`, not billed).
- Default output (no rules): `{ meta: { from, to, subject, receivedAt, messageId }, fields: <"Key: Value" lines parsed to JSON>, raw: { text, html? } }` (html and attachments: metadata only, no attachment content in v1). Cap body at 256 KB.
- Delivery: `POST` JSON to the target URL through `SafeHttpClient` (section 8). 2xx = success.
- Loop protection: drop mail with `Auto-Submitted` ≠ `no`, `Precedence: bulk/auto_reply`, or sent from the platform's own domain.

### Module 3: Telegram / Discord (`chat_relay`)
- Trigger: `POST /i/<ingestToken>`; Telegram button callbacks arrive at `POST /tg/<relayId>/<secret>` (register with `setWebhook` when the relay is saved).
- Required config: name, platform (`telegram`|`discord`), bot token (Telegram) or webhook URL (Discord), chat ID (Telegram only), message template (Markdown).
- Advanced: Telegram inline buttons (label + URL or callback_data; templates allowed in URL).
- Telegram: `sendMessage`, 4096-char limit (truncate with ellipsis), escape template **values** correctly for the chosen `parse_mode` so payload data cannot break formatting. Discord webhook: 2000-char limit, respect 429 `Retry-After`.
- Validation: on save, verify token via `getMe` (Telegram) / URL shape check (Discord); surface a clear inline error.

### Module 4: Calendar Bridge (`calendar_bridge`)
- Trigger: `POST /i/<ingestToken>` (booking form/webhook).
- Required config: name, Google connection (OAuth button), title template, `startPath`, `endPath` (ISO 8601 JSONPath).
- Time handling: timestamps with offset are used as-is; without offset they are interpreted in the account timezone (default `Europe/Bucharest`, luxon). `end <= start` = terminal `INVALID_TIME_RANGE`.
- Advanced: SMS reminder. Checkbox + offset (e.g. 2 h before). When checked, reveal inside Advanced: recipient phone path and SMS provider credentials (prefill from the user's existing SMS relay if any). The reminder is stored in `scheduled_reminders` **and** scheduled as a delayed BullMQ job; on worker start, re-enqueue pending reminders from the DB (durability). Reminder = billed as `sms_dispatch`.
- Google: scope `calendar.events` only, primary calendar, refresh token encrypted. Token revoked/expired = terminal `GOOGLE_AUTH_REVOKED` + email notification asking the user to reconnect; the relay is set to inactive.

---

## 7. Reliability, credits, loops, retention

**Out of credits (hold, don't lose).** If `balance < price` at ingest: event = `HELD_NO_CREDIT`, `held_until = now + 48h`, send ONE email per 24 h per user (`notifications` dedupe key): "Relay failed: top up to deliver messages." On successful top-up, release held events oldest-first into the `deliver` queue. Maintenance job (every 5 min) sets held events past `held_until` to `EXPIRED` and sends one summary email.

**Low balance:** email once when balance falls below €1 (deduped per top-up cycle).

**Destination failure:** retry policy in section 5.

**Loop protection:** Redis key `loop:<relayId>:<sha256(canonical payload)>` with `INCR` + 60 s TTL. More than **10** identical relays in a minute → `DROPPED_LOOP`, logged, not billed, one deduped email. Email module has the header-based guard above.

**Idempotency:** optional `Idempotency-Key` header on ingest (24 h dedupe per relay). Stripe events deduped via `processed_provider_events`. Ledger writes always carry an `idempotency_key`.

**GDPR retention:** daily maintenance job deletes `event_payloads` rows past `purge_after` (30 days). `events`, `delivery_attempts` metadata and ledger rows stay. Payload content must never be written to application logs (pino redaction for `payload*`, `token*`, `secret*`, `authorization`, `password`).
Account deletion (script `pnpm admin:delete-user`, exposed later) removes all user data except ledger rows required for accounting (anonymized).

---

## 8. Security requirements (blocking, not optional)

1. **Secrets at rest:** AES-256-GCM encryption for `relays.config_secret` and OAuth refresh tokens. Key from `ENCRYPTION_KEY` (32 bytes base64), stored blob = `keyId:iv:tag:ciphertext` so keys can rotate. Secrets are **write-only** in the UI: the API never returns them, forms show `••••` with a "Replace" action.
2. **SSRF-safe outbound HTTP** (`SafeHttpClient`): http/https only, ports 80/443 by default, resolve DNS and connect to the validated IP, block loopback, RFC1918, link-local (169.254/16 incl. cloud metadata), CGNAT 100.64/10, `0.0.0.0`, IPv6 ULA/link-local; no automatic redirects (or re-validate each hop); 10 s timeout; response body cap 1 MB, stored excerpt 8 KB. Used by every module that calls a user-supplied URL.
3. **Webhook authenticity:** optional HMAC validation on raw body with constant-time comparison (`timingSafeEqual`). Stripe webhooks: verify the signature on the raw body.
4. **Ingest tokens** are bearer secrets: 32+ random chars, never logged, rotatable (Advanced → "Regenerate URL").
5. **Auth:** argon2id, email verification required before creating relays, login rate limiting, session rotation on login, CSRF defense (SameSite=Lax + `Origin` check on state-changing routes), secure cookies in production.
6. **Input limits:** body size, template length (2 KB), JSONPath length, max 25 relays per account, max 5 MB request memory per ingest.
7. **Least privilege:** Google `calendar.events` only; Stripe restricted keys where possible; DB user without superuser rights.
8. **Dependency hygiene:** `pnpm audit` in CI (warn), lockfile committed, no `postinstall` surprises.

---

## 9. API surface (Fastify, JSON, zod-validated, cookie session unless noted)

```
POST /api/auth/register | /login | /logout | /verify-email | /forgot | /reset
GET  /api/me                                  # user + balance
GET  /api/relays            POST /api/relays
GET  /api/relays/:id        PATCH /api/relays/:id     DELETE /api/relays/:id
POST /api/relays/:id/test                     # D9: real delivery, source=test
POST /api/relays/:id/rotate-token
GET  /api/logs?relayId=&status=&cursor=       # cursor pagination
GET  /api/logs/:eventId                       # metadata + payloads (if not purged) + attempts
POST /api/billing/checkout                    # { amountEur } -> Stripe Checkout URL (min 5, max 100)
GET  /api/billing/history
GET  /api/oauth/google/start | /callback
POST /api/webhooks/stripe                     # no session, signature verified
POST /i/:ingestToken                          # public ingest
POST /inbound/email/:provider                 # public, authenticated per provider
POST /tg/:relayId/:secret                     # Telegram callbacks
GET  /healthz | /readyz
```

Standard error shape: `{ error: { code, message, fields? } }` with stable machine codes from `packages/shared`.

---

## 10. Web UI (exactly 4 screens + auth pages)

Non-negotiable UI rules: extreme simplicity; only strictly necessary fields; **info icon `(?)` on every non-trivial field** (hover/click popover with a short explanation and a real example); **Advanced** = collapsed `Collapsible` by default, never in the main flow; no flow diagrams, no drag-and-drop; sensible defaults; clean inline validation.

Build these shared components first: `<InfoTip title example>`, `<AdvancedSection>`, `<SecretInput>` (write-only), `<JsonPathInput>` (validates syntax, shows a live preview against the sample payload), `<TemplateInput>` (highlights `{{$.path}}`, shows resolved preview), `<CopyField>`.

1. **Dashboard `/dashboard`:** relay table (Name, Type, Status toggle, triggers last 30 days, actions), `+ New Relay`, balance chip (`Balance: €12.50` + `Top up`). Empty state = one sentence and the New Relay button.
2. **Relay create/edit `/relays/new`, `/relays/:id`:** 4-step guided form: **1 name & type → 2 input (trigger) → 3 output (destination) → 4 `Send Test Payload`**. Step 2 shows the ingest URL (or email address) with Copy button. Step 4 prefills `sampleInput()`, lets the user edit the JSON, shows rendered output and the cost before sending, then shows the result (status, request/response excerpt). Field lists per module are in section 6; required vs Advanced split must match exactly.
3. **Logs `/logs`:** timestamp, relay, status (`SUCCESS 200` / `FAILED 500` / `HELD` / `DROPPED`), cost (`−€0.005`). Row click opens a drawer: incoming vs outgoing payload, attempts. Show "Payload deleted after 30 days" when purged.
4. **Billing `/billing`:** buttons €5 / €10 / €25 plus custom amount (min €5) → Stripe Checkout; balance and top-up/charge history. Show a one-line note that Stripe card fees make very small top-ups less efficient.

Design: light, calm, lots of whitespace, one accent color, system font stack or Inter, accessible contrast, mobile-usable (the dashboard and logs must work at 375 px).

Google OAuth owner note (put in README): while the OAuth consent screen is in *Testing* status, refresh tokens expire after 7 days and only listed test users can connect. Move it to *Production* (with the `calendar.events` scope, expect Google's verification process for public use) before real users rely on Module 4.

---

## 11. Billing (Stripe)

- `PaymentProvider` interface: `createCheckout(userId, amountCents)`, `handleWebhook(rawBody, signature)`.
- Checkout Session `mode=payment`, `currency=eur`, `price_data` with the chosen amount, `client_reference_id = userId`, metadata `{ topupId }`. Success/cancel URLs back to `/billing`.
- On `checkout.session.completed` (and `checkout.session.async_payment_succeeded` if enabled): verify signature on raw body, dedupe via `processed_provider_events`, mark top-up paid, write ledger `topup` (idempotency key `topup:<sessionId>`), release held events (section 7).
- Refunds/chargebacks: manual via admin script that writes an `adjustment`/`refund` ledger row.
- Use Stripe test mode + `stripe listen` in dev; document in README.

---

## 12. Admin scripts (no admin UI)

`pnpm admin:credit --email x --amount 5.00 --reason "..."` (ledger `adjustment`), `pnpm admin:user --email x` (balance, relays, last events), `pnpm admin:release-held --email x`, `pnpm admin:delete-user --email x`.

---

## 13. Observability and ops

- pino JSON logs with request id and event id correlation; redaction list from section 7.
- `/healthz` (process up), `/readyz` (DB + Redis reachable). Worker exposes a heartbeat key in Redis.
- Optional Sentry via `SENTRY_DSN` (off when unset).
- Queue hygiene: `removeOnComplete` with age cap, `removeOnFail` retained 7 days.
- Graceful shutdown for API and worker (finish in-flight jobs).
- Backups: README section with `pg_dump` cron example and restore steps. Redis is treated as rebuildable (DB is the source of truth; on worker start, re-enqueue `QUEUED`/`HELD` events and pending reminders that have no live job).

### Environment variables (`.env.example`, zod-validated at startup, fail fast)
`NODE_ENV`, `APP_URL`, `INBOUND_DOMAIN`, `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, `ENCRYPTION_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MAIL_FROM`, `MAIL_PROVIDER` (+ provider keys), `INBOUND_EMAIL_PROVIDER` (+ secrets), `WHATSAPP_ENABLED=false`, `SENTRY_DSN` (optional), `TRUST_CLOUDFLARE=false`.

---

## 14. Delivery plan (execute in order, commit after each phase)

Each phase ends with: `pnpm typecheck && pnpm lint && pnpm test` green, a short commit series (Conventional Commits, English), and a 5-line status report (done / decisions applied / deviations / risks / next).

**Phase 0: Foundation.** Inspect the repo first (it may hold only a README or a partial scaffold; reuse what fits this plan, remove what doesn't). pnpm workspace, tsconfig base, eslint/prettier, vitest, docker-compose dev (postgres, redis, mailpit), env module, `.gitignore` (secrets, `.env`, build output), `ci.yml`. *Done when:* `docker compose up -d && pnpm install && pnpm build` works from a clean clone.

**Phase 1: Data + engine core.** Drizzle schema + migrations + seed (pricing). Ledger functions (credit, charge, idempotency, row locking) with concurrency tests. Engine: JSONPath, templates, phone normalization, HMAC verify, AES-GCM crypto, `SafeHttpClient` (with SSRF tests), module contract, shared zod schemas. *Done when:* unit tests cover template edge cases, SSRF block list, ledger double-charge prevention, encryption round-trip and key rotation.

**Phase 2: API + worker skeleton.** Auth, sessions, relays CRUD (secrets encrypted, write-only), ingest endpoint (steps 1–6 of section 5), `deliver` queue with custom backoff, attempts logging, hold/release, loop guard, maintenance jobs (held expiry, retention purge, low-balance, reminder re-enqueue), mailer interface + notifications dedupe. Ship with a fake `echo` module used only in tests to prove the whole pipeline before real adapters. *Done when:* an integration test posts a webhook and observes SUCCESS + ledger charge; forced 500s produce 3 retries at 1/5/15 min (use fake timers); out-of-credit hold → top-up → auto-release works; 11th identical payload/minute is dropped.

**Phase 3: The four module adapters.** Module 1 (SMSLink, Twilio, Infobip stub), Module 2 (inbound adapter + parsing rules + filters + loop guard), Module 3 (Telegram + Discord + buttons + callback route), Module 4 (Google OAuth + event creation + reminders). All provider calls tested against msw mocks; record any adapter that could not be verified against live docs. *Done when:* each module has a passing end-to-end test (ingest → adapter mock → ledger charge at the correct price → log entry).

**Phase 4: Web UI.** Shared components, auth pages, the 4 screens, per-module form definitions driven by `configSchema` + field metadata (label, required/advanced, info text, example). *Done when:* a new user can register, verify (mailpit), create one relay of each type, send a test payload, see it in Logs, and top up (Stripe test mode). Playwright smoke test covers relay creation for Module 1. Verify the required-vs-Advanced split against section 6 field by field.

**Phase 5: Stripe.** Checkout + webhook + history + release-held integration; idempotency tests with replayed events. *Done when:* `stripe listen` replay of the same event credits once.

**Phase 6: Hardening + docs + deploy assets.** Walk the section 8 checklist and record evidence (tests or code refs) in `docs/SECURITY_CHECKLIST.md`. Dockerfiles (multi-stage, non-root), `docker-compose.prod.yml`, `deploy/nginx.smartrelay.conf`, `deploy/deploy.sh`, manual-only `deploy.yml`, README (setup, env, Stripe/Google/inbound-email setup, backups, runbook for stuck queues and refunds). Load test: 100 req/s sustained ingest on a small VPS profile with acknowledged p95 < 200 ms (use `autocannon`, report numbers). *Done when:* `docker compose -f docker-compose.prod.yml up` on a fresh VPS-like environment serves the app and a full relay works.

---

## 15. Acceptance checklist (final report must tick each line with evidence)

- [ ] All 4 modules work end to end with correct prices (€0.005 / €0.005 / €0.01 / €0.025).
- [ ] Only successful deliveries are billed; failed and dropped events cost nothing.
- [ ] Held events survive 48 h and auto-release after top-up; expired ones notify once.
- [ ] Retries at 1 / 5 / 15 min; terminal errors are not retried.
- [ ] Loop guard: >10 identical relays/min dropped; inbound-email auto-reply guard works.
- [ ] Payload content purged after 30 days; metadata and ledger retained; no payload/secret in app logs.
- [ ] Secrets encrypted at rest and never returned by the API.
- [ ] SSRF tests pass (private ranges, metadata IP, redirects).
- [ ] HMAC validation works for WooCommerce and Shopify presets.
- [ ] UI: exactly 4 screens (+ auth), every non-trivial field has an info tip with an example, Advanced collapsed by default, required fields only in the main flow.
- [ ] Stripe test-mode top-up credits exactly once, even on replayed webhooks.
- [ ] `ci.yml` green on `main`; `deploy.yml` is manual-only; no secrets in the repo history.
- [ ] Final report lists: deviations from this plan, unverified provider integrations, owner-only tasks (section 1), and known risks.

---

## 16. Later (do not start)

WhatsApp via approved provider · managed SMS mode with pass-through provider cost (D1) · iCal/Apple calendar · SMS notifications to the account owner · Netopia payments · Romanian/Hungarian UI catalogs · roadmap modules (IoT heartbeat, e-Factura relay, payment gateway switcher, AI privacy proxy, image relay, status/failover relay) · a Claude Skill that scaffolds "new relay module" (adapter + zod schema + form metadata + tests).
