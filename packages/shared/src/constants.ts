import type { PricingKind } from './enums';

/** 1 EUR = 1,000,000 micro-euros. All money in the system is bigint micro-euros. */
export const MICRO_PER_EUR = 1_000_000n;

/** Seed values for the `pricing` table (EUR 0.005 / 0.01 / 0.025). */
export const DEFAULT_PRICES_MICRO: Readonly<Record<PricingKind, bigint>> = {
  relay_http: 5_000n,
  calendar_event: 10_000n,
  sms_dispatch: 25_000n,
};

export const LIMITS = {
  maxTemplateLength: 2_048,
  maxJsonPathLength: 256,
  /** Stored excerpt of a destination response. */
  responseExcerptBytes: 8 * 1024,
  /** Ingest request body (MASTER_PLAN section 5, step 2). */
  ingestBodyBytes: 256 * 1024,
} as const;

/** More than this many identical payloads to one relay within 60 s triggers the loop guard. */
export const LOOP_GUARD_THRESHOLD = 10;
export const LOOP_GUARD_WINDOW_S = 60;

/** Held events (insufficient credit) expire after this long unheld. */
export const HELD_EVENT_TTL_MS = 48 * 3600 * 1000;

export const OUTBOUND_HTTP = {
  timeoutMs: 10_000,
  maxResponseBytes: 1024 * 1024,
  defaultPorts: [80, 443],
} as const;
