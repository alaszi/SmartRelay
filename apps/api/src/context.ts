import type { Db } from '@smartrelay/db';
import type { Keyring, Mailer } from '@smartrelay/engine';
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
}
