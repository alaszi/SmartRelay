import { randomBytes, randomUUID } from 'node:crypto';
import { createDb, seedPricing, type DbHandle } from '@smartrelay/db';
import {
  createRecordingMailer,
  createSafeHttpClient,
  Keyring,
  type ModuleRegistry,
  type RecordingMailer,
} from '@smartrelay/engine';
import { createEchoModule } from '@smartrelay/engine/testing';
import { DELIVER_QUEUE_NAME, type Env } from '@smartrelay/shared';
import { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import Redis from 'ioredis';
import { buildApp, type App } from '../src/app';
import type { AppContext } from '../src/context';

/** Every relay type wired to the echo test module, at realistic prices, so any relay a test
 * creates is immediately deliverable end to end. */
export function defaultTestModules(): ModuleRegistry {
  return {
    webhook_sms: createEchoModule('webhook_sms', 'sms_dispatch'),
    email_api: createEchoModule('email_api', 'relay_http'),
    chat_relay: createEchoModule('chat_relay', 'relay_http'),
    calendar_bridge: createEchoModule('calendar_bridge', 'calendar_event'),
  };
}

export const TEST_APP_URL = 'http://localhost:3000';

export function testDatabaseUrl(): string {
  return (
    process.env['TEST_DATABASE_URL'] ??
    'postgres://smartrelay:smartrelay@localhost:5432/smartrelay_test'
  );
}

export function testRedisUrl(): string {
  return process.env['TEST_REDIS_URL'] ?? 'redis://localhost:6379';
}

export async function resetDb(dbHandle: DbHandle['db']): Promise<void> {
  const current = await dbHandle.execute<{ name: string }>(sql`SELECT current_database() AS name`);
  const name = current.rows[0]?.name ?? '';
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to reset database "${name}": name must end with _test`);
  }
  const tables = await dbHandle.execute<{ tablename: string }>(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const list = tables.rows.map((row) => `"${row.tablename}"`).join(', ');
  await dbHandle.execute(sql.raw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`));
  await seedPricing(dbHandle);
}

export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    APP_URL: TEST_APP_URL,
    API_PORT: 3001,
    INBOUND_DOMAIN: 'inbound.localhost',
    DATABASE_URL: testDatabaseUrl(),
    REDIS_URL: testRedisUrl(),
    SESSION_SECRET: 'x'.repeat(32),
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    ENCRYPTION_KEY_ID: 'k1',
    MAIL_FROM: 'SmartRelay <no-reply@smartrelay.localhost>',
    MAIL_PROVIDER: 'smtp',
    SMTP_URL: 'smtp://localhost:1025',
    INBOUND_EMAIL_PROVIDER: 'postmark',
    WHATSAPP_ENABLED: false,
    TRUST_CLOUDFLARE: false,
    ...overrides,
  };
}

export interface TestApp {
  app: App;
  ctx: AppContext;
  mailer: RecordingMailer;
  close: () => Promise<void>;
}

export function buildTestApp(
  overrides: Partial<Env> = {},
  modules: ModuleRegistry = defaultTestModules(),
): TestApp {
  const env = testEnv(overrides);
  const dbHandle = createDb(env.DATABASE_URL);
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const keyring = new Keyring({ id: env.ENCRYPTION_KEY_ID, key: env.ENCRYPTION_KEY });
  const mailer = createRecordingMailer();
  // A distinct, unique queue name per test app instance so BullMQ state never bleeds between tests.
  const deliverQueue = new Queue(`${DELIVER_QUEUE_NAME}-test-${randomUUID()}`, {
    connection: redis,
  });

  // Test destinations bind to a random ephemeral port, so every port must be allowed (the default
  // allow-list is just 80/443). Address-level SSRF checks are covered elsewhere
  // (packages/engine/src/safe-http.test.ts); this only relaxes what test servers need.
  const http = createSafeHttpClient({
    unsafeAllowPrivateAddresses: true,
    allowedPorts: Array.from({ length: 65535 }, (_, i) => i + 1),
  });
  const ctx: AppContext = {
    env,
    db: dbHandle.db,
    redis,
    keyring,
    mailer,
    deliverQueue,
    modules,
    http,
  };
  const app = buildApp(ctx);

  return {
    app,
    ctx,
    mailer,
    close: async () => {
      await app.close();
      await deliverQueue.obliterate({ force: true }).catch(() => undefined);
      await deliverQueue.close();
      await dbHandle.close();
      redis.disconnect();
    },
  };
}
