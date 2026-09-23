# Acceptance report (MASTER_PLAN section 15)

Walked top to bottom in Phase 6/7. Every line below has a test, a code reference, or a live check
against the real dev database/stack — not just a typecheck. Three real bugs were found and fixed in
the process (not just documented): the loop-detection email never existed, a calendar-bridge error
message leaked payload content into logs, and CI's `Test` step has been timing out on every recent
push because Redis was never provisioned. See individual commits for full detail on each.

## 1. All 4 modules work end to end with correct prices

**Done**, with one caveat (see deviations). Prices: `packages/shared/src/constants.ts`'s
`DEFAULT_PRICES_MICRO` (`relay_http: 5_000n`, `calendar_event: 10_000n`, `sms_dispatch: 25_000n`,
i.e. €0.005/€0.01/€0.025), asserted against the plan's exact wording in
`packages/shared/src/money.test.ts`. Each module's `priceKind()` maps to the right one
(`module-chat-relay.ts`, `module-email-api.ts` → `relay_http`; `module-calendar-bridge.ts` →
`calendar_event`; `module-webhook-sms.ts` → `sms_dispatch`), matching section 6's table exactly.
Each module has its own dedicated test file
(`module-{webhook-sms,email-api,chat-relay,calendar-bridge}.test.ts`); `runDeliverJob`'s generic
pipeline (charges at the module's price, marks `SUCCESS`) is covered in
`packages/db/src/deliver.int.test.ts`. Live-verified this session: a `chat_relay` (Discord) relay
created, ingested, held for zero balance, credited, and delivered to a real reachable endpoint with
a genuine `SUCCESS` status recorded, through the actual production Docker stack behind Nginx (Phase
6). Module 4's Advanced "SMS reminder" was **not** re-verified live and, per the deviations section
below, isn't actually implemented — the core Module 4 flow (create a calendar event) is complete and
tested; the reminder sub-feature is not.

## 2. Only successful deliveries are billed

**Done.** `packages/db/src/deliver.ts`: `chargeEvent` is called exactly once, inside
`if (result.ok)`. Terminal failures call `markFailed` (never `chargeEvent`).
`DROPPED_LOOP`/`REJECTED` events are created directly with terminal status and are never enqueued at
all (`createEvent` sets `finishedAt` immediately for those statuses and the ingest/inbound-email
routes never call `deliverQueue.add` for them), so `costMicro` stays at its `0` default. Covered in
`deliver.int.test.ts`'s "success"/"terminal failures" describe blocks.

## 3. Held events survive 48 h and auto-release after top-up; expired ones notify once

**Done.** `HELD_EVENT_TTL_MS = 48 * 3600 * 1000` (`packages/shared/src/constants.ts`), set on
`heldUntil` at ingest time when balance is insufficient (`apps/api/src/routes/ingest.ts`).
Auto-release: `releaseHeldEvents` (`packages/db/src/events.ts`) + enqueue, exercised by
`billing.int.test.ts` and live-verified twice this session — once during Phase 6 (real Stripe-style
top-up releasing a held event through the full Docker stack) and once via the new `admin:release-held`
script (credited a fixture user, released a held event, confirmed both the Postgres status flip to
`QUEUED` **and** the job actually landing in Redis's `bull:deliver:*` list). Expiry + notify-once:
`expireStaleHeldEvents` and the maintenance job's dedupe (`apps/worker/src/maintenance.ts`) had **no
test coverage at all** before this session — verified live first (backdated `heldUntil`, ran the real
function, confirmed `EXPIRED` status; ran `tryRecordNotification` twice with the same key, confirmed
the second call is a no-op), then added `packages/db/src/events.int.test.ts` and
`notifications.int.test.ts` so it can't silently regress. Both maintenance jobs are actually
scheduled (`apps/worker/src/main.ts`: held-expiry every 5 min, retention-purge daily, low-balance
every 15 min).

## 4. Retries at 1 / 5 / 15 min; terminal errors are not retried

**Done.** `DELIVER_RETRY_DELAYS_MS = [60_000, 300_000, 900_000]`, `deliverBackoffMs`
(`packages/shared/src/queue.ts`). `deliver.int.test.ts`'s "retryable failures" block covers a 500
returning `retry` and staying unbilled, a terminal 4xx marking `FAILED` without retry, and a network
error treated the same as a 5xx.

## 5. Loop guard: >10 identical relays/min dropped; inbound-email auto-reply guard works

**Done — one real bug found and fixed.** `LOOP_GUARD_THRESHOLD = 10`, `LOOP_GUARD_WINDOW_S = 60`
(`packages/shared/src/constants.ts`); Redis `INCR` + TTL keyed per relay + canonical payload hash
(`apps/api/src/routes/ingest.ts`). This exact threshold was hit live and unprompted during the Phase
6 load test (a poorly-varied test payload tripped `LOOP_DETECTED` at request #11), and is covered by
`ingest.int.test.ts`'s "loop guard" block. **What was missing:** section 7 promises "one deduped
email" per loop; no such email existed in any phase. Fixed this session — `ingest.ts` now sends one
email per relay per 60 s guard window (deduped via `tryRecordNotification`, same mechanism the
held-expiry job uses), with a new test asserting exactly one email for two separate drops in the same
window. Inbound-email's auto-reply guard (`Auto-Submitted`, `Precedence: bulk/auto_reply`, platform's
own domain) is a separate, simpler one-shot header check (`isLoopedEmail`,
`packages/engine/src/module-email-api.ts`) with thorough unit coverage
(`module-email-api.test.ts`) and integration coverage
(`apps/api/src/routes/inbound-email.int.test.ts`'s "loop protection" block).

## 6. Payload content purged after 30 days; metadata/ledger retained; no payload/secret in app logs

**Done — one real bug found and fixed.** `PAYLOAD_RETENTION_MS` = 30 days
(`packages/db/src/events.ts`). `purgeExpiredPayloads` had no test coverage before this session —
live-verified (backdated `purge_after`, ran the real function, confirmed the row was gone but the
parent `events` row survived), then added to `events.int.test.ts`. `apps/api/src/logger.ts`'s pino
redaction list covers `payload`, `payloadIn`, `payloadOut`, `token`, `ingestToken`, `secret`,
`configSecret`, `password`, `authorization`, headers. **What was actually broken:** while checking
this line, `module-calendar-bridge.ts`'s timestamp validation embedded the raw payload value it
failed to parse directly into its error message — a message that reaches
`delivery_attempts.error_message` (whose own schema comment says "must never contain secrets or
payload content") and, via `apps/worker/src/deliver.ts`'s `throw new UnrecoverableError(...)`, the
worker's **plain, unredacted** `process.stderr.write`. Fixed: the message now names the JSONPath
that failed, never the value it extracted; a regression test asserts the payload value never appears
in the message. **Risk still open, not fixed:** `apps/worker` doesn't use pino at all — every worker
log line is a raw `process.stdout`/`stderr.write`, with no redaction layer whatsoever. Today nothing
else was found leaking payload/secret content into it (checked every module's error `message`
construction), but there's no structural safety net the way `apps/api` has one; a future module or
error path could reintroduce this class of bug silently.

## 7. Secrets encrypted at rest and never returned by the API

**Done.** Live-checked this session: `select config_secret from relays` on the real dev DB returns
values in exactly the documented `keyId:iv:tag:ciphertext` form (e.g.
`k1:2kCg77sJjjEQ9lN-:nqzxiVe1plqEaMpesyBpcA:OLTfI0ewHVPfuy...`), never plaintext.
`packages/db/src/relays.ts`'s `toPublic()` destructures `configSecret` out of every row returned to
the API at the type level, replacing it with a `hasSecret` boolean; every relay-creation response
captured live this session (Phase 6 and this pass) confirms this in practice.

## 8. SSRF tests pass (private ranges, metadata IP, redirects)

**Done.** `packages/engine/src/ip.test.ts` has 150+ parametrized cases: RFC1918, loopback,
link-local including `169.254.169.254` (cloud metadata) in both plain and IPv6-embedded forms
(`::ffff:...`, `64:ff9b::...`, 6to4), CGNAT, IPv6 ULA/link-local/multicast, and a "fails closed on
anything that isn't a clean IP literal" block covering decimal/octal/hex IP forms, zone ids, and
whitespace tricks. `safe-http.test.ts` covers redirects not being followed automatically. Full suite
(850 tests) passing; this is exactly the kind of logic unit tests are the right tool for, so no
separate live check was run beyond confirming the suite passes.

## 9. HMAC validation works for WooCommerce and Shopify presets

**Done — live-verified with real signatures, not just unit tests.** Presets in
`packages/engine/src/hmac.ts` are checked against shopify.dev and
developer.woocommerce.com/docs/apis/rest-api/v3/webhooks/ per the file's own comment.
`hmac.test.ts` exercises both presets at the unit level. This session additionally started a real
api instance, created one relay per preset with its exact header name/algorithm/encoding, computed
genuine HMAC-SHA256 signatures in Node against real request bodies, and confirmed: a correctly
signed WooCommerce request → `202`; a correctly signed Shopify request → `202`; a wrong signature for
either → `401 HMAC_INVALID`.

## 10. UI: exactly 4 screens (+ auth), info tips, Advanced collapsed, required-only main flow

**Done, structurally verified — not re-walked live in a browser this pass.** Routes match section
10 exactly: `dashboard`, `relays/new` + `relays/:id` (one screen, create/edit), `logs`, `billing`,
plus the 5 auth pages (`login`, `register`, `forgot-password`, `reset-password`, `verify-email`).
All six required shared components exist (`InfoTip`, `AdvancedSection`, `SecretInput`,
`JsonPathInput`, `TemplateInput`, `CopyField`) and are actually used across the four module-specific
forms, not just defined and orphaned: `InfoTip` appears in all four; `AdvancedSection` appears in
`webhook-sms-form.tsx` and `email-api-form.tsx` (the two modules whose Advanced sections are actually
built). `chat-relay-form.tsx` has no `AdvancedSection` because its Advanced feature (Telegram inline
buttons) is deferred (known, tracked). `calendar-bridge-form.tsx` has no `AdvancedSection` because
its Advanced feature (SMS reminder) doesn't exist — see deviations. This item relies on code
structure plus the Playwright smoke test added in Phase 4, not a fresh live walkthrough at 375px
this session.

## 11. Stripe test-mode top-up credits exactly once, even on replayed webhooks

**Done.** `apps/api/src/routes/billing.int.test.ts` posts an identical, genuinely-signed webhook
payload twice (Stripe SDK's real `webhooks.generateTestHeaderString`, not a mock) and asserts the
balance moves exactly once. Backed by `wasProviderEventProcessed`'s
`processed_provider_events` idempotency table and `markTopupPaid`'s `pending`-only guard. Verified
live in Phase 5 (prior session) and re-confirmed passing in every full-suite run this session.

## 12. `ci.yml` green on `main`; `deploy.yml` is manual-only; no secrets in the repo history

**Mixed — one real bug found and fixed, needs a push to fully confirm.** Checked actual GitHub
Actions run history via the API rather than assuming: the last 5 pushes' `Test` step ran for
~14.5 minutes and was cut off by the job's 15-minute timeout, right after `Typecheck` and `Lint` both
genuinely passed. `ci.yml` only ever provisioned Postgres; the test suite's BullMQ-backed tests need
Redis too, and the test helpers' `ioredis` clients use `maxRetriesPerRequest: null`, so with nothing
to connect to they retry forever instead of failing fast — `vitest.config.ts` even had a stale
comment ("Postgres, later Redis") that was never acted on. Fixed: added a `redis:7-alpine` service
to `ci.yml` mirroring the existing `postgres` one. **This has not been confirmed green yet** — that
needs an actual push and a completed run, and per this project's standing rule these commits are not
pushed without being told to. `deploy.yml`: confirmed `on: workflow_dispatch` only, no `push`
trigger — manual-only as required. No secrets in history: scanned full git history (`git log --all
-p`) for `.env`-shaped file additions and live-looking secret patterns (Stripe live/test keys, AWS
access keys, PEM private key headers, Slack tokens) — none found; `.env` was never committed at any
point and is gitignored.

## 13. This report

Deviations, unverified integrations, owner-only tasks, and risks below.

---

## Deviations from this plan

- **Telegram inline buttons** (Module 3, Advanced): deferred. Text templates and plain links work;
  interactive buttons are not implemented. Known and tracked since Phase 4.
- **SMS reminder** (Module 4, Advanced) — **found this session, not previously tracked.** Section 6
  describes it fully: a checkbox + offset, stored in `scheduled_reminders` and scheduled as a
  delayed BullMQ job, re-enqueued from the DB on worker start, billed as `sms_dispatch`. The
  `scheduled_reminders` table exists in the schema and nothing else — no UI field, no write path, no
  BullMQ scheduling, no worker re-enqueue logic anywhere in `apps/worker`, `packages/db`, or
  `packages/engine`. This is a real, complete feature gap, not a small fix; it was not built as part
  of this pass.
- **Cloudflare `CF-Connecting-IP` range validation** (section 3): "trust `CF-Connecting-IP` only
  from Cloudflare ranges, otherwise use the socket address" was never implemented in any phase.
  Phase 6 fixed the more urgent half of this (real per-client IP attribution through Nginx, via
  `trustProxy: (_, hop) => hop === 0`) but did not add Cloudflare-range validation, since that needs
  Cloudflare's current published IP list and isn't needed for this deployment's actual topology
  (Nginx only, no CDN in front). Documented in the README and `SECURITY_CHECKLIST.md`.
- **`apps/worker` has no structured logging or redaction layer**: every log line is a raw
  `process.stdout`/`stderr.write`. Not itself a bug (nothing currently leaks through it beyond the
  one fixed this session), but it's a gap relative to section 13's "pino JSON logs ... redaction
  list from section 7," which reads as applying project-wide, not just to `apps/api`.

## Unverified / stubbed provider integrations

- **Infobip** (SMS provider, Module 1): explicitly a typed stub per decision D2 — not a real,
  working integration (`packages/engine/src/module-webhook-sms.ts`'s own comment says so).
  SMSLink and Twilio are real integrations.
- **WhatsApp**: explicitly out of scope for this milestone (`WHATSAPP_ENABLED=false`, decisions
  table).
- **Google OAuth in "Testing" publishing status**: while the OAuth consent screen stays in Testing
  (Google Cloud Console default), refresh tokens expire after 7 days and only explicitly-listed test
  users can connect Module 4. Documented in the README as an owner action before real users depend
  on it.

## Owner-only tasks (section 1 and elsewhere, code cannot enforce these)

- Choosing and provisioning the production VPS, and setting the `DEPLOY_HOST`/`DEPLOY_USER`/
  `DEPLOY_SSH_KEY` repo secrets `deploy.yml` needs.
- Creating a Stripe **restricted** API key (Checkout Sessions + Webhook Endpoints only) rather than
  using a full secret key — whatever key is configured is what the app uses; the app cannot enforce
  the restriction itself.
- Provisioning the production Postgres with an application-only role (not `postgres` superuser) on
  any managed/external Postgres — the app never runs superuser-only statements, but provisioning
  itself is the operator's job.
- Moving the Google OAuth consent screen from Testing to Production status (triggers Google's
  verification process) before real users rely on Module 4.
- Deciding whether Cloudflare (or any CDN) ever fronts this deployment, and if so, building the
  `CF-Connecting-IP` range validation section 3 calls for.

## Known risks

- **CI's Redis fix is unverified** until pushed and a real run completes green — flagged rather
  than claimed.
- **Module 4 is only partially complete** relative to section 6's spec: the core flow (create a
  calendar event) works end to end; the Advanced SMS-reminder sub-feature does not exist.
- **`apps/worker`'s unredacted plain-text logging** is a structural gap (see deviations) — low
  current risk (one concrete leak found and fixed, nothing else found on inspection) but no
  systemic safety net against a future one.
- **UI item 10 wasn't re-walked live in a browser** this pass; it relies on code structure and the
  existing Phase 4 Playwright smoke test rather than a fresh end-to-end check of every screen.
- **5 commits from this pass are not yet pushed** (admin scripts, maintenance job test coverage, the
  loop-notification fix, the CI Redis fix, the calendar-bridge log-leak fix) — standing project rule
  is not to push without being told to.
