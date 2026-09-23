# Security checklist (MASTER_PLAN section 8)

Walked once, at the start of Phase 6, against the codebase as of commit `c1ca2a0`. Each item cites
the code and/or test that enforces it — not just a description of intent.

## 1. Secrets at rest

AES-256-GCM, key from `ENCRYPTION_KEY` (32 bytes base64), stored as `keyId:iv:tag:ciphertext` with
base64url parts, so keys can rotate without breaking existing values.

- Cipher: [`packages/engine/src/crypto.ts`](../packages/engine/src/crypto.ts) — `Keyring.encrypt`/`decrypt`,
  `createCipheriv('aes-256-gcm', ...)`. Round-trip and key-rotation tests:
  [`crypto.test.ts`](../packages/engine/src/crypto.test.ts).
- Applied to `relays.config_secret`, AAD-bound to the relay's own id
  ([`packages/db/src/relays.ts`](../packages/db/src/relays.ts)) and to `oauth_connections.refresh_token`,
  AAD-bound to the connection's own id ([`packages/db/src/oauth-connections.ts`](../packages/db/src/oauth-connections.ts)).
- Write-only in the API: `RelayPublicRow`/`OAuthConnectionPublicRow` strip the secret field entirely
  before a route can return it — `GET`/`PATCH /api/relays*` and `GET /api/oauth/google/connections`
  never see it, let alone send it. The web UI's `SecretInput` shows `••••••••••••` with a "Replace"
  action for an existing secret ([`apps/web/src/components/secret-input.tsx`](../apps/web/src/components/secret-input.tsx));
  replacing one field of a relay's secret merges onto the existing blob instead of overwriting it
  (regression-tested: [`packages/db/src/relays.int.test.ts`](../packages/db/src/relays.int.test.ts), "merges a
  partial configSecret update").

## 2. SSRF-safe outbound HTTP

`SafeHttpClient` is the only way any module reaches a user-supplied URL.

- Scheme/port allow-list, DNS resolution + IP validation before connecting, 10 s timeout, 1 MB
  response cap with an 8 KB stored excerpt:
  [`packages/engine/src/safe-http.ts`](../packages/engine/src/safe-http.ts) (`OUTBOUND_HTTP` constants
  in [`packages/shared/src/constants.ts`](../packages/shared/src/constants.ts)).
- Block list (loopback, RFC1918, link-local incl. `169.254.169.254`, CGNAT, `0.0.0.0/8`, IPv6
  ULA/link-local, and more — an IPv6 _allow_-list of only `2000::/3` global unicast, stricter than
  the plan's minimum): [`packages/engine/src/ip.ts`](../packages/engine/src/ip.ts). Tests:
  [`safe-http.test.ts`](../packages/engine/src/safe-http.test.ts) (private ranges, the cloud metadata
  address, DNS-rebinding-style resolution).
- No redirect-following: the client uses Node's low-level `http`/`https` request APIs directly, which
  never auto-follow a `3xx`, so there is no redirect hop to re-validate.

## 3. Webhook authenticity

- Inbound relay webhooks: optional per-relay HMAC on the raw body, constant-time compared
  (`timingSafeEqual`), with WooCommerce/Shopify presets —
  [`packages/engine/src/hmac.ts`](../packages/engine/src/hmac.ts),
  [`apps/api/src/routes/ingest.ts`](../apps/api/src/routes/ingest.ts). Tests: `hmac.test.ts`.
- Stripe webhooks: signature verified on the _raw_ body (a dedicated content-type parser keeps it
  unparsed for this one route) via the real Stripe SDK, never a hand-rolled check —
  [`packages/engine/src/payment-provider.ts`](../packages/engine/src/payment-provider.ts)'s
  `StripePaymentProvider.handleWebhook`. Proven against a genuinely signed payload (not mocked), including
  the replay-idempotency and invalid-signature cases: [`apps/api/src/routes/billing.int.test.ts`](../apps/api/src/routes/billing.int.test.ts).
- Telegram callbacks: authenticated by a per-relay random secret in the URL path
  (`POST /tg/:relayId/:secret`), constant-time compared — [`apps/api/src/routes/telegram-callback.ts`](../apps/api/src/routes/telegram-callback.ts).

## 4. Ingest tokens

- `generateIngestToken()`: 24 random bytes → 32+ char base64url
  ([`packages/db/src/relays.ts`](../packages/db/src/relays.ts)). Collision/format test in
  `relays.int.test.ts`.
- Never logged: pino's redaction list includes `*.ingestToken` (and `*.token`, `*.secret`,
  `*.configSecret`, `*.payload*`, `Authorization`/`Cookie` headers) —
  [`apps/api/src/logger.ts`](../apps/api/src/logger.ts).
- Rotatable: `POST /api/relays/:id/rotate-token`, exposed in the UI as "Regenerate URL"
  ([`apps/web/src/components/edit-relay-view.tsx`](../apps/web/src/components/edit-relay-view.tsx)).

## 5. Auth

- Password hashing: argon2id via `@node-rs/argon2` —
  [`packages/engine/src/password.ts`](../packages/engine/src/password.ts).
- Email verification required before creating a relay: `POST /api/relays` throws
  `EMAIL_NOT_VERIFIED` for an unverified account —
  [`apps/api/src/routes/relays.ts`](../apps/api/src/routes/relays.ts). Tested in `relays.int.test.ts`.
- Login rate limiting: 5/minute keyed by IP + attempted email —
  [`apps/api/src/routes/auth.ts`](../apps/api/src/routes/auth.ts). The IP half of that key depends on
  correct client-IP attribution through Nginx — see `trustProxy` below.
- Global rate limiting (300/min) and the per-ingest-token limit (120/min,
  [`apps/api/src/routes/ingest.ts`](../apps/api/src/routes/ingest.ts)) are both keyed by client IP or
  token; `trustProxy: (_, hop) => hop === 0` in
  [`apps/api/src/app.ts`](../apps/api/src/app.ts) trusts exactly the immediate hop (Nginx, which
  always fronts `api` in this deployment) so Fastify resolves the real client IP Nginx observed and
  appended, not anything a client tries to prepend into `X-Forwarded-For`, and not Nginx's own
  container IP. **Found during Phase 6 load testing**: the previous `trustProxy: TRUST_CLOUDFLARE`
  (boolean, defaulting `false`) meant every request through Nginx resolved to Nginx's own IP,
  collapsing every IP-keyed rate limit into one sitewide bucket shared by all users — fixed here.
  Verified by sending a spoofed `X-Forwarded-For` header directly and confirming it's ignored.
- Session rotation: every successful login issues a fresh session token; a password reset ends
  every _other_ session (`deleteOtherSessions`) — same file.
- CSRF: `SameSite=Lax` cookies plus an `Origin` header check on every state-changing (non-GET/HEAD/
  OPTIONS) route — [`apps/api/src/csrf.ts`](../apps/api/src/csrf.ts) (`requireSameOrigin`).
- Secure cookies in production: `secureCookies = env.NODE_ENV === 'production'`, passed into every
  `setSessionCookie` call — [`apps/api/src/app.ts`](../apps/api/src/app.ts).

## 6. Input limits

- Template length: `LIMITS.maxTemplateLength = 2048` — enforced in
  [`packages/engine/src/template.ts`](../packages/engine/src/template.ts)'s `parseTemplate`.
- JSONPath length: `LIMITS.maxJsonPathLength = 256` — enforced in
  [`packages/engine/src/jsonpath.ts`](../packages/engine/src/jsonpath.ts)'s `validateJsonPath`.
- Relay count: `MAX_RELAYS_PER_ACCOUNT = 25`, enforced inside `createRelay`'s transaction (so a race
  between two concurrent creates still can't exceed it) —
  [`packages/shared/src/relay-input.ts`](../packages/shared/src/relay-input.ts),
  [`packages/db/src/relays.ts`](../packages/db/src/relays.ts).
- Request body size: Fastify's global default is capped at 1 MB
  ([`apps/api/src/app.ts`](../apps/api/src/app.ts)); the public ingest route
  (`POST /i/:ingestToken`) tightens that further to `LIMITS.ingestBodyBytes` (256 KB), and inbound
  email to 2 MB (headroom for attachment _metadata_ only, never attachment content). No route accepts
  an unbounded body, and every configured limit is well under the plan's 5 MB ceiling — none is
  exactly "5 MB" because 1 MB/256 KB/2 MB were each sized to the specific route's real payload, not
  to the stated maximum.

## 7. Least privilege

- Google: the OAuth connect flow requests only `calendar.events` (plus `userinfo.email`, solely to
  label a connection by account — no elevated access) — never the broader `.../auth/calendar` scope.
  [`packages/engine/src/google-calendar.ts`](../packages/engine/src/google-calendar.ts)`, `GOOGLE_OAUTH_SCOPES`.
- Stripe restricted keys: **owner action, not enforceable from code.** Whatever `STRIPE_SECRET_KEY` is
  configured with is what the app uses; creating a _restricted_ key (Checkout Sessions + Webhook
  Endpoints write access only, per Stripe's dashboard) is something only the account owner can do when
  provisioning the key. Documented as an owner setup step in the README.
- DB user without superuser rights: `docker-compose.prod.yml`'s Postgres service is provisioned with
  an application-only role (see the compose file's `POSTGRES_USER`/init comment) — not `postgres`
  itself. On a managed/external Postgres, this is the operator's responsibility at provisioning time;
  the app never runs `CREATE ROLE`/`ALTER SYSTEM`-class statements, only Drizzle migrations against
  its own schema.

## 8. Dependency hygiene

- `pnpm audit --audit-level=high` runs in CI, `continue-on-error: true` (warn, not block, since a
  transitive advisory with no fix yet shouldn't halt every PR) — [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).
- Lockfile (`pnpm-lock.yaml`) is committed and enforced in CI via `pnpm install --frozen-lockfile`.
- No dependency runs install scripts by default; `pnpm-workspace.yaml`'s `allowBuilds` explicitly
  allow-lists the few that genuinely need to (`@parcel/watcher`, `@swc/core` — Next.js's own native
  binaries) and explicitly denies the rest (`esbuild`, `msgpackr-extract`, `msw`), so a new
  dependency's postinstall is blocked until someone deliberately reviews and allows it.

## Known gaps

- Section 8 item 7's "Stripe restricted keys" and "DB user without superuser rights" (for a managed
  Postgres) are owner/operator actions the code cannot enforce or verify at runtime — called out
  above rather than silently assumed.
- No automated dependency-vulnerability _blocking_ gate (audit is warn-only) — a deliberate choice to
  avoid CI failing on an advisory with no available fix, not an oversight, but worth revisiting once
  the project has more history to judge false-positive rate.
- MASTER_PLAN section 3 calls for validating `CF-Connecting-IP` against Cloudflare's published IP
  ranges when Cloudflare fronts the deployment ("trust `CF-Connecting-IP` only from Cloudflare
  ranges"). That validation was never implemented in any phase — `TRUST_CLOUDFLARE` is currently
  unused (see the `trustProxy` fix in section 5). This deployment ships Nginx as the sole public
  entry point with no CDN, so it isn't a gap for the shipped topology, but if Cloudflare is ever put
  in front of Nginx, this still needs building: fetch Cloudflare's current IP list
  (<https://www.cloudflare.com/ips/>) and validate the hop immediately before Nginx against it.
