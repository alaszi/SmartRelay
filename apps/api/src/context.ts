import type { Db } from '@smartrelay/db';
import type {
  Keyring,
  Mailer,
  ModuleRegistry,
  PaymentProvider,
  SafeHttpClient,
} from '@smartrelay/engine';
import type { DeliverJobData, Env } from '@smartrelay/shared';
import type { Queue } from 'bullmq';
import type Redis from 'ioredis';

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
  /** Undefined when STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET are not configured (billing routes
   * then 503). A `PaymentProvider`, not the raw Stripe SDK (MASTER_PLAN section 11): billing
   * routes never touch Stripe's client directly, so a future provider is a drop-in. */
  paymentProvider?: PaymentProvider;
}
