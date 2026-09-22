import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  EVENT_SOURCES,
  EVENT_STATUSES,
  LEDGER_KINDS,
  OAUTH_PROVIDERS,
  PAYMENT_PROVIDERS,
  PRICING_KINDS,
  RELAY_STATUSES,
  RELAY_TYPES,
  REMINDER_STATUSES,
  SMS_MODES,
  TOPUP_STATUSES,
} from '@smartrelay/shared';

const citext = customType<{ data: string }>({
  dataType: () => 'citext',
});

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** Money is stored as bigint micro-euros (1 EUR = 1,000,000). Never a float. */
const microEur = (name: string) => bigint(name, { mode: 'bigint' });

export const relayTypeEnum = pgEnum('relay_type', RELAY_TYPES);
export const relayStatusEnum = pgEnum('relay_status', RELAY_STATUSES);
export const smsModeEnum = pgEnum('sms_mode', SMS_MODES);
export const pricingKindEnum = pgEnum('pricing_kind', PRICING_KINDS);
export const ledgerKindEnum = pgEnum('ledger_kind', LEDGER_KINDS);
export const eventSourceEnum = pgEnum('event_source', EVENT_SOURCES);
export const eventStatusEnum = pgEnum('event_status', EVENT_STATUSES);
export const paymentProviderEnum = pgEnum('payment_provider', PAYMENT_PROVIDERS);
export const topupStatusEnum = pgEnum('topup_status', TOPUP_STATUSES);
export const oauthProviderEnum = pgEnum('oauth_provider', OAUTH_PROVIDERS);
export const reminderStatusEnum = pgEnum('reminder_status', REMINDER_STATUSES);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: citext('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  emailVerifiedAt: timestamptz('email_verified_at'),
  timezone: text('timezone').notNull().default('Europe/Bucharest'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  // Single-use, hashed (see packages/engine/src/token.ts). Not in the plan's data model; added
  // because section 9 requires /verify-email, /forgot and /reset and there is no dedicated table.
  emailVerifyTokenHash: text('email_verify_token_hash').unique(),
  emailVerifyExpiresAt: timestamptz('email_verify_expires_at'),
  passwordResetTokenHash: text('password_reset_token_hash').unique(),
  passwordResetExpiresAt: timestamptz('password_reset_expires_at'),
});

export const sessions = pgTable(
  'sessions',
  {
    /** SHA-256 (hex) of the random 256-bit session token. The raw token only lives in the cookie. */
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamptz('expires_at').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('sessions_user_id_idx').on(t.userId),
    index('sessions_expires_at_idx').on(t.expiresAt),
  ],
);

/** Row-locked (`FOR UPDATE`) for every ledger write. */
export const creditAccounts = pgTable('credit_accounts', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** May dip slightly below zero: in-flight jobs are allowed to finish (decision D11). */
  balanceMicro: microEur('balance_micro')
    .notNull()
    .default(sql`0`),
});

/**
 * Append-only (enforced by a trigger, see the ledger_append_only migration). `userId` becomes NULL
 * when a user is deleted so accounting rows survive anonymized.
 */
export const creditLedger = pgTable(
  'credit_ledger',
  {
    /** Gapless-per-insert ordering key; `created_at` is the transaction start, not commit order. */
    seq: bigint('seq', { mode: 'bigint' }).notNull().generatedAlwaysAsIdentity(),
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    deltaMicro: microEur('delta_micro').notNull(),
    kind: ledgerKindEnum('kind').notNull(),
    refType: text('ref_type'),
    refId: text('ref_id'),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    balanceAfterMicro: microEur('balance_after_micro').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('credit_ledger_user_seq_idx').on(t.userId, t.seq),
    check(
      'credit_ledger_delta_sign',
      sql`(${t.kind} = 'topup' AND ${t.deltaMicro} > 0)
        OR (${t.kind} = 'charge' AND ${t.deltaMicro} < 0)
        OR (${t.kind} IN ('adjustment', 'refund') AND ${t.deltaMicro} <> 0)`,
    ),
  ],
);

export const topups = pgTable(
  'topups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    provider: paymentProviderEnum('provider').notNull(),
    /** Null until the provider session exists. */
    providerSessionId: text('provider_session_id').unique(),
    amountCents: integer('amount_cents').notNull(),
    status: topupStatusEnum('status').notNull().default('pending'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('topups_user_id_idx').on(t.userId),
    check('topups_amount_positive', sql`${t.amountCents} > 0`),
  ],
);

/** Webhook idempotency: a provider event id is processed at most once. */
export const processedProviderEvents = pgTable(
  'processed_provider_events',
  {
    provider: paymentProviderEnum('provider').notNull(),
    eventId: text('event_id').notNull(),
    processedAt: timestamptz('processed_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.eventId] })],
);

export const pricing = pgTable(
  'pricing',
  {
    kind: pricingKindEnum('kind').primaryKey(),
    priceMicro: microEur('price_micro').notNull(),
  },
  (t) => [check('pricing_price_positive', sql`${t.priceMicro} > 0`)],
);

export const relays = pgTable(
  'relays',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: relayTypeEnum('type').notNull(),
    status: relayStatusEnum('status').notNull().default('active'),
    /** Bearer secret, 32+ chars base64url. Never logged. */
    ingestToken: text('ingest_token').notNull().unique(),
    /** Non-secret fields, safe to return to the UI. */
    configPublic: jsonb('config_public').$type<Record<string, unknown>>().notNull().default({}),
    /** AES-256-GCM blob `keyId:iv:tag:ciphertext`. Write-only from the UI's point of view. */
    configSecret: text('config_secret'),
    smsMode: smsModeEnum('sms_mode').notNull().default('byo'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    lastTriggeredAt: timestamptz('last_triggered_at'),
  },
  (t) => [index('relays_user_id_idx').on(t.userId)],
);

export const relayEmailAddresses = pgTable('relay_email_addresses', {
  relayId: uuid('relay_id')
    .primaryKey()
    .references(() => relays.id, { onDelete: 'cascade' }),
  /** `r_<8 chars>@<INBOUND_DOMAIN>` */
  address: text('address').notNull().unique(),
});

export const oauthConnections = pgTable(
  'oauth_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: oauthProviderEnum('provider').notNull(),
    accountEmail: text('account_email').notNull(),
    /** Encrypted with the same AES-256-GCM scheme as relays.config_secret. */
    refreshToken: text('refresh_token').notNull(),
    scopes: text('scopes').array().notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [unique('oauth_connections_account_unique').on(t.userId, t.provider, t.accountEmail)],
);

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    relayId: uuid('relay_id')
      .notNull()
      .references(() => relays.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    source: eventSourceEnum('source').notNull(),
    status: eventStatusEnum('status').notNull().default('RECEIVED'),
    /** Hash of the Idempotency-Key header (24 h dedupe window is enforced by the query). */
    dedupeHash: text('dedupe_hash'),
    heldUntil: timestamptz('held_until'),
    costMicro: microEur('cost_micro')
      .notNull()
      .default(sql`0`),
    finalStatusCode: integer('final_status_code'),
    errorCode: text('error_code'),
    receivedAt: timestamptz('received_at').notNull().defaultNow(),
    finishedAt: timestamptz('finished_at'),
  },
  (t) => [
    index('events_user_received_idx').on(t.userId, t.receivedAt),
    index('events_relay_received_idx').on(t.relayId, t.receivedAt),
    index('events_status_held_until_idx').on(t.status, t.heldUntil),
    index('events_relay_dedupe_idx').on(t.relayId, t.dedupeHash),
  ],
);

/** The only table that holds user payload content. Rows are purged after `purgeAfter`. */
export const eventPayloads = pgTable(
  'event_payloads',
  {
    eventId: uuid('event_id')
      .primaryKey()
      .references(() => events.id, { onDelete: 'cascade' }),
    payloadIn: jsonb('payload_in'),
    payloadOut: jsonb('payload_out'),
    /** Destination response, truncated to 8 KB by the writer. */
    responseExcerpt: text('response_excerpt'),
    purgeAfter: timestamptz('purge_after').notNull(),
  },
  (t) => [
    index('event_payloads_purge_after_idx').on(t.purgeAfter),
    check(
      'event_payloads_excerpt_size',
      sql`${t.responseExcerpt} IS NULL OR octet_length(${t.responseExcerpt}) <= 8192`,
    ),
  ],
);

export const deliveryAttempts = pgTable(
  'delivery_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    attemptNo: integer('attempt_no').notNull(),
    startedAt: timestamptz('started_at').notNull().defaultNow(),
    durationMs: integer('duration_ms'),
    ok: boolean('ok').notNull(),
    statusCode: integer('status_code'),
    errorCode: text('error_code'),
    /** Must never contain secrets or payload content. */
    errorMessage: text('error_message'),
  },
  (t) => [unique('delivery_attempts_event_attempt_unique').on(t.eventId, t.attemptNo)],
);

export const scheduledReminders = pgTable(
  'scheduled_reminders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    relayId: uuid('relay_id')
      .notNull()
      .references(() => relays.id, { onDelete: 'cascade' }),
    runAt: timestamptz('run_at').notNull(),
    status: reminderStatusEnum('status').notNull().default('pending'),
  },
  (t) => [index('scheduled_reminders_status_run_at_idx').on(t.status, t.runAt)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    sentAt: timestamptz('sent_at').notNull().defaultNow(),
  },
  (t) => [unique('notifications_user_dedupe_unique').on(t.userId, t.dedupeKey)],
);
