import type { Db } from '@smartrelay/db';
import type { Keyring, Mailer, ModuleRegistry, SafeHttpClient } from '@smartrelay/engine';
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
   * callback); module delivery itself only ever runs in apps/worker. */
  http: SafeHttpClient;
}
