import type { z } from 'zod';
import type { PricingKind, RelayType } from '@smartrelay/shared';
import type { SafeHttpClient } from './safe-http';

export interface ModuleContext {
  eventId: string;
  userTimezone: string;
  /** The only way an adapter may reach a user-supplied URL. */
  http: SafeHttpClient;
  now: Date;
  /** The app's own Google OAuth client (shared across every user's Calendar connection, unlike a
   * per-relay secret). Undefined when GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are not configured. */
  google?: { clientId: string; clientSecret: string };
}

export interface ModuleSuccess {
  ok: true;
  statusCode: number;
  request: unknown;
  response: unknown;
  extra?: Record<string, unknown>;
}

export interface ModuleFailure {
  ok: false;
  /** Retryable = network error, timeout, HTTP 5xx or 429. Everything else is terminal. */
  retryable: boolean;
  errorCode: string;
  /** Must not contain secrets or payload content. */
  message: string;
  statusCode?: number;
  /** From a 429's `Retry-After` header; the caller's backoff should honor it if larger (section 5). */
  retryAfterMs?: number;
  request?: unknown;
  response?: unknown;
}

export type ModuleResult = ModuleSuccess | ModuleFailure;

/**
 * A relay module is a pure adapter: it turns a payload plus its config into one outbound call and
 * reports the outcome. It never writes to the database; the worker records attempts and bills.
 * Adding a module means one adapter and one form definition, with no special case in the pipeline.
 */
export interface RelayModule<TConfig> {
  type: RelayType;
  /** Shared with the web form validation. */
  configSchema: z.ZodType<TConfig>;
  priceKind: (config: TConfig) => PricingKind;
  execute: (args: {
    config: TConfig;
    /** The parsed inbound payload. */
    payload: unknown;
    ctx: ModuleContext;
  }) => Promise<ModuleResult>;
  /** Prefills the "Send Test Payload" step. */
  sampleInput: () => unknown;
}

/**
 * Maps a relay type to its adapter. `any` is deliberate: each module has its own config type, and
 * the registry is looked up generically by the pipeline (ingest, worker) which only ever passes a
 * module its own already-validated config. A type with no entry is not implemented yet.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ModuleRegistry = Partial<Record<RelayType, RelayModule<any>>>;
