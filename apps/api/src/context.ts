import type { Db } from '@smartrelay/db';
import type { Keyring, Mailer, ModuleRegistry, SafeHttpClient } from '@smartrelay/engine';
import type { DeliverJobData, Env } from '@smartrelay/shared';
import type { Queue } from 'bullmq';
import type Redis from 'ioredis';
import type Stripe from 'stripe';

/** Everything a route needs, injected so tests can swap real infra for fakes/in-memory doubles. */
export interface AppContext {
  env: Env;
  db: Db;
  redis: Redis;
  keyring: Keyring;
  mailer: Mailer;
  deliverQueue: Queue<DeliverJobData>;
  /** Empty in production until Phase 3 ships real adapters; tests inject a fake module. */
  modules: ModuleRegistry;
  /** Used for the handful of API-initiated provider calls (e.g. acknowledging a Telegram button
   * callback, or a "Send Test Payload" delivery); background delivery itself runs in apps/worker. */
  http: SafeHttpClient;
  /** Module 4 only (Google Calendar), for the same reason as apps/worker/src/deliver.ts. */
  google?: { clientId: string; clientSecret: string };
  /** Undefined when STRIPE_SECRET_KEY is not configured (billing routes then 503). */
  stripe?: Stripe;
}
