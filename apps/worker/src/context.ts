import type { Db } from '@smartrelay/db';
import type { Keyring, Mailer, ModuleRegistry, SafeHttpClient } from '@smartrelay/engine';
import type { DeliverJobData, Env } from '@smartrelay/shared';
import type { Queue } from 'bullmq';
import type Redis from 'ioredis';

export interface WorkerContext {
  env: Env;
  db: Db;
  redis: Redis;
  keyring: Keyring;
  mailer: Mailer;
  deliverQueue: Queue<DeliverJobData>;
  /** Empty in production until Phase 3 ships real adapters; tests inject a fake module. */
  modules: ModuleRegistry;
  /** Shared SSRF-safe client passed to every module's execute(); modules never build their own. */
  http: SafeHttpClient;
}
