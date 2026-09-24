# Acceptance report (MASTER_PLAN section 15)

Walked top to bottom in Phase 6/7. Every line below has a test, a code reference, or a live check
against the real dev database/stack — not just a typecheck, and "CI is green" was verified by
reading the Annotations panel on real runs, not by trusting the top-level badge alone. Real bugs
found and fixed in the process (not just documented): the loop-detection email never existed; a
calendar-bridge error message leaked payload content into logs; CI's `Test` step had been timing
out on every recent push because Redis was never provisioned; a relay-config validation bug that
only surfaced once Module 4's SMS reminder gave a relay a second, independently-editable secret
field; and two real high-severity CVEs in `nodemailer` that a `continue-on-error` audit step was
correctly warning about but not blocking on — found by taking a green badge with a visible error
annotation seriously instead of assuming the badge alone meant nothing was wrong. Section 15's
original walkthrough also surfaced that Module 4's Advanced "SMS reminder" — described in full in
section 6 — didn't exist beyond an inert DB table; it was built in a follow-up pass (see the
addendum below) to the same standard as everything else and live-verified against the real dev
stack. See individual commits for full detail on each.

## 1. All 4 modules work end to end with correct prices

**Done.** Prices: `packages/shared/src/constants.ts`'s `DEFAULT_PRICES_MICRO` (`relay_http:
5_000n`, `calendar_event: 10_000n`, `sms_dispatch: 25_000n`, i.e. €0.005/€0.01/€0.025), asserted
against the plan's exact wording in `packages/shared/src/money.test.ts`. Each module's
`priceKind()` maps to the right one (`module-chat-relay.ts`, `module-email-api.ts` → `relay_http`;
`module-calendar-bridge.ts` → `calendar_event`; `module-webhook-sms.ts` → `sms_dispatch`, and its
Advanced SMS reminder also `sms_dispatch`), matching section 6's table exactly. Each module has its
own dedicated test file (`module-{webhook-sms,email-api,chat-relay,calendar-bridge}.test.ts`);
`runDeliverJob`'s generic pipeline (charges at the module's price, marks `SUCCESS`) is covered in
`packages/db/src/deliver.int.test.ts`. Live-verified this session: a `chat_relay` (Discord) relay
created, ingested, held for zero balance, credited, and delivered to a real reachable endpoint with
a genuine `SUCCESS` status recorded, through the actual production Docker stack behind Nginx (Phase
6). Module 4's Advanced "SMS reminder" — previously a documented feature gap (see the retired
deviation note below) — was built this session: schema, scheduling, BullMQ delayed job, worker
re-enqueue-on-start durability, UI, and tests, then live-verified against the real dev stack (a real
running worker process picked up a delayed job, made a genuine HTTPS call to Twilio's real API, and
correctly handled both a live network failure and a simulated crash-recovery restart — full detail
below).

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
forms, not just defined and orphaned: `InfoTip` appears in all four; `AdvancedSection` now appears
in three of four (`webhook-sms-form.tsx`, `email-api-form.tsx`, and — as of this session —
`calendar-bridge-form.tsx`'s new SMS reminder section). `chat-relay-form.tsx` has no
`AdvancedSection` because its Advanced feature (Telegram inline buttons) is deferred (known,
tracked — the only remaining case of an Advanced feature not built). This item relies on code
structure plus the Playwright smoke test added in Phase 4, not a fresh live walkthrough at 375px
this session.

## 11. Stripe test-mode top-up credits exactly once, even on replayed webhooks

**Done.** `apps/api/src/routes/billing.int.test.ts` posts an identical, genuinely-signed webhook
payload twice (Stripe SDK's real `webhooks.generateTestHeaderString`, not a mock) and asserts the
balance moves exactly once. Backed by `wasProviderEventProcessed`'s
`processed_provider_events` idempotency table and `markTopupPaid`'s `pending`-only guard. Verified
live in Phase 5 (prior session) and re-confirmed passing in every full-suite run this session.

## 12. `ci.yml` green on `main`; `deploy.yml` is manual-only; no secrets in the repo history

**Done — two real bugs found, fixed, and confirmed green by checking the Annotations panel, not
just the badge.**

**Bug 1 (Redis).** Checked actual GitHub Actions run history via the API rather than assuming: the
last 5 pushes' `Test` step ran for ~14.5 minutes and was cut off by the job's 15-minute timeout,
right after `Typecheck` and `Lint` both genuinely passed. `ci.yml` only ever provisioned Postgres;
the test suite's BullMQ-backed tests need Redis too, and the test helpers' `ioredis` clients use
`maxRetriesPerRequest: null`, so with nothing to connect to they retry forever instead of failing
fast — `vitest.config.ts` even had a stale comment ("Postgres, later Redis") that was never acted
on. Fixed: added a `redis:7-alpine` service to `ci.yml` mirroring the existing `postgres` one.

**Bug 2 (a genuinely contradictory green badge).** After the Redis fix, the run's top-level badge
read "Success," but its Annotations panel showed "1 error" — "Process completed with exit code 1."
Every individual step (including a fresh run triggered by an unrelated later push, to rule out a
one-off) independently reported `success` via the Checks API, so this wasn't a masked
Typecheck/Lint/Test/Build failure. Root-caused by reproducing it locally: `pnpm audit
--audit-level=high` genuinely exits 1 in ~1.3s (matching the CI step's exact duration both times),
because `nodemailer@7.0.13` carries two real high-severity advisories (GHSA-p6gq-j5cr-w38f: the
`raw` message option bypasses `disableFileAccess`/`disableUrlAccess` — arbitrary file read + SSRF;
GHSA-2x7j-588g-ccc2: O(n²) address parsing — DoS). `ci.yml`'s Audit step has `continue-on-error:
true` by design (documented, deliberate "warn, don't block" policy in `SECURITY_CHECKLIST.md`) —
exactly why the step's own conclusion stayed "success" while the annotation still surfaced the real
underlying failure honestly, rather than hiding it. Checked nodemailer's actual changelog before
upgrading (not guessed): v8's only breaking change is an error-code rename this codebase never
checks; v9's is TLS validation on remote-content fetching (attachments/OAuth2), which
`createSmtpMailer` never does; v10 needs Node 20+, already satisfied. Upgraded to `^10.0.10`; no
usage changes needed; full suite (878 tests) still green; `pnpm audit --audit-level=high` now exits
0 locally (3 remaining findings are transitive dev-tooling, moderate/low, already below this
project's documented threshold). Pushed and verified on a third run
([run 35963047330](https://github.com/alaszi/SmartRelay/actions/runs/35963047330), commit
`fd7a77f`): badge green **and** the Annotations panel now shows only the two pre-existing,
GitHub-infrastructure-level notices (Node 20 deprecation on the runner, Ubuntu 26 migration) —
zero failure-level annotations.

`deploy.yml`: confirmed `on: workflow_dispatch` only, no `push` trigger — manual-only as required.
No secrets in history: scanned full git history (`git log --all -p`) for `.env`-shaped file
additions and live-looking secret patterns (Stripe live/test keys, AWS access keys, PEM private key
headers, Slack tokens) — none found; `.env` was never committed at any point and is gitignored.

## 13. This report

Deviations, unverified integrations, owner-only tasks, and risks below.

---

## Addendum: Module 4's "SMS reminder" (built this session)

Found missing while first walking this checklist (documented as a deviation), then built to the
same standard as everything else, per an explicit follow-up request. Full design and every file
touched are in the commit history; summary:

- **Schema**: `calendarBridgeConfigSchema` (`packages/engine/src/module-calendar-bridge.ts`) gained
  a `reminderMode` discriminated union (`'off' | 'smslink' | 'twilio' | 'infobip'`), matching
  section 6's "checkbox + offset, reveal recipient phone path and SMS provider credentials"
  exactly. Every field is flat at the top level rather than nested under a shared `reminder`
  object, because `configSecret` patches are a _shallow_ merge onto whatever is already stored
  (`updateRelay`) — a nested secret field would be silently dropped by that merge whenever some
  other top-level field changed without it. A `z.preprocess` step defaults `reminderMode` to `'off'`
  when the field is absent entirely, so every relay saved before this feature existed keeps
  validating exactly as it did before (verified: `apps/api/src/routes/module-calendar-bridge.e2e.int.test.ts`'s
  existing fixtures, which predate the field, initially broke and were the signal for this fix).
- **Pipeline wiring stayed module-agnostic.** `module.ts`'s own stated design rule is "no special
  case in the pipeline" — so rather than teaching `runDeliverJob` about calendar_bridge
  specifically, `RelayModule` gained an optional `scheduleFollowUp?(config, result)` hook. The
  pipeline just calls it after a successful charge and persists whatever `{ runAt }` comes back,
  with zero awareness of what the follow-up actually is. Only `calendarBridgeModule` implements it.
- **Scheduling**: `runDeliverJob` (`packages/db/src/deliver.ts`) creates a `scheduled_reminders` row
  via `createScheduledReminder` and returns its id/runAt on the `DeliverOutcome`; both callers
  (`apps/worker/src/deliver.ts`'s BullMQ processor, and `apps/api/src/routes/relays.ts`'s "Send Test
  Payload" route, since decision D9 already treats test sends as real billed deliveries) enqueue the
  delayed job onto a new `reminder` BullMQ queue (`packages/shared/src/queue.ts`).
- **Sending**: `runReminderJob` (`packages/db/src/reminders.ts`) re-validates the relay's config
  fresh at send time (not trusted from scheduling time — a relay can be edited or deactivated in
  between), re-checks balance, sends via `sendReminderSms` (`packages/engine/src/reminder-sms.ts`,
  which mirrors `module-webhook-sms.ts`'s `execute()` exactly — same phone normalization, same
  provider dispatch), and on success charges `sms_dispatch` directly against the ledger
  (`applyLedgerEntry`, since there's no `events` row for a reminder itself). Insufficient balance at
  send time fails outright — no charge, no send, no retry, no hold — a deliberately simpler policy
  than the primary pipeline's HELD_NO_CREDIT/48h/auto-release machinery, since section 6 doesn't
  specify hold semantics for reminders and building that out is its own separate scope.
- **Durability**: `apps/worker/src/main.ts` re-enqueues every still-`pending` reminder on startup
  (`reenqueuePendingReminders`, mirroring the existing `reenqueueStuckEvents` pattern exactly, same
  `jobId`-is-idempotent reasoning), satisfying section 6's explicit requirement.
- **Bug found and fixed while wiring the UI**: `apps/api/src/routes/relays.ts`'s
  `assertValidModuleConfig` validated `request.body.configSecret` _alone_ (not merged with what
  `updateRelay` actually keeps), which happened to work only because every module previously had
  exactly one secret field, always resent whole. The reminder adds a second, independently-editable
  one (`refreshToken` for Google vs. `reminderSecret` for the SMS provider) that exposed this. Fixed
  to merge onto the existing decrypted secret the same way `updateRelay` does.
- **UI**: `calendar-bridge-form.tsx` gained an `AdvancedSection` — checkbox, offset (minutes),
  recipient phone JSONPath, message template, provider select, and provider-specific fields —
  mirroring `webhook-sms-form.tsx`'s Advanced HMAC section pattern field-for-field. Also implements
  section 6's "prefill from the user's existing SMS relay if any": on mount, if this reminder isn't
  already configured, it fetches the user's relays and prefills the provider and its non-secret
  fields from an existing `webhook_sms` relay (never the secret itself — write-only, section 8.1).
- **Tests**: schema validation (each provider variant, the "off" default, rejecting an incomplete
  enabled config) and `scheduleFollowUp`'s own runAt math in
  `module-calendar-bridge.test.ts`; the SMS-sending logic in `reminder-sms.test.ts` (mirrors
  `module-webhook-sms.test.ts`'s happy-path/terminal/retryable structure); the generic pipeline
  wiring (a synthetic module's `scheduleFollowUp` creates the right DB row) in `deliver.int.test.ts`;
  the full `runReminderJob` orchestration — success+charge, idempotent replay, cancelled when the
  relay went inactive or the reminder was turned off, insufficient balance, terminal vs. retryable
  provider failures, `listPendingReminders` filtering — in the new `reminders.int.test.ts`, against
  the real Postgres test database. 878 tests pass across the whole suite.
- **Live verification against the real dev stack** (not just typechecked, per the explicit
  request): started the real `apps/worker` process against the real dev Postgres/Redis. (1)
  Created a real fixture (user, calendar_bridge relay with Twilio-shaped-but-fake credentials, a
  triggering event, a `scheduled_reminders` row) and enqueued a real 2-second-delayed BullMQ job;
  the running worker picked it up after the delay elapsed, made a genuine HTTPS call to Twilio's
  real API (`api.twilio.com`), received a real `401` ("Authentication Error - invalid username" —
  Twilio's actual response to fake credentials), and correctly marked the reminder `failed` with
  **zero** ledger charge, confirmed directly in Postgres. (2) Separately verified the durability
  requirement: created a `pending` reminder that was deliberately **never** enqueued (simulating a
  crash between scheduling and enqueueing, or a Redis flush), confirmed via `redis-cli` that no
  BullMQ job existed for it and it stayed stuck, killed and restarted the real worker process, and
  confirmed its startup `reenqueuePendingReminders()` found and processed it within seconds — the
  exact scenario section 6's durability requirement exists for. The success+charge path itself
  (a real `2xx` from the provider) is proven by `reminders.int.test.ts` against real Postgres with a
  mocked HTTP response, not by a live run — no real Twilio/SMSLink/Infobip account is available in
  this environment to obtain valid credentials, so a genuine "provider says yes" response isn't
  something a live check here could honestly claim beyond what the mocked-HTTP integration test
  already proves.

---

## Deviations from this plan

- **Telegram inline buttons** (Module 3, Advanced): deferred. Text templates and plain links work;
  interactive buttons are not implemented. Known and tracked since Phase 4. This is now the only
  remaining "documented in section 6, not built" gap.
- ~~**SMS reminder** (Module 4, Advanced)~~ — found this session, built this session. See the
  addendum above for the full design and live verification.
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

- **`apps/worker`'s unredacted plain-text logging** is a structural gap (see deviations) — low
  current risk (one concrete leak found and fixed, nothing else found on inspection) but no
  systemic safety net against a future one.
- **UI item 10 wasn't re-walked live in a browser** this pass; it relies on code structure and the
  existing Phase 4 Playwright smoke test rather than a fresh end-to-end check of every screen.
- **The SMS reminder's insufficient-balance handling is simpler than the primary pipeline's**: it
  fails outright (no send, no charge, no retry) rather than holding for 48h and auto-releasing on
  top-up. A deliberate scope decision (section 6 doesn't specify hold semantics for reminders), not
  an oversight — flagged here in case the owner wants it to match the primary pipeline's behavior.
- **Reminder retry policy reuses the primary pipeline's 1/5/15-minute backoff** by choice, since
  section 6 doesn't specify one for reminders — a reasonable default, but an interpretation, not a
  stated requirement.
