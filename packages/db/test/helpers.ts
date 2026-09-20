import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb, type Db, type DbHandle } from '../src/client';
import { seedPricing } from '../src/pricing';
import { events, relays, users } from '../src/schema';

const DEFAULT_TEST_DATABASE_URL = 'postgres://smartrelay:smartrelay@localhost:5432/smartrelay_test';

export function testDatabaseUrl(): string {
  return process.env['TEST_DATABASE_URL'] ?? DEFAULT_TEST_DATABASE_URL;
}

export function createTestDb(max = 20): DbHandle {
  return createDb(testDatabaseUrl(), { max });
}

/** Empties every table. Refuses to run against any database whose name does not end in _test. */
export async function resetDb(db: Db): Promise<void> {
  const current = await db.execute<{ name: string }>(sql`SELECT current_database() AS name`);
  const name = current.rows[0]?.name ?? '';
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to reset database "${name}": name must end with _test`);
  }

  const tables = await db.execute<{ tablename: string }>(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const list = tables.rows.map((row) => `"${row.tablename}"`).join(', ');
  await db.execute(sql.raw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`));
  await seedPricing(db);
}

export async function createUser(db: Db, email = `user-${randomUUID()}@example.com`) {
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash: 'not-a-real-hash' })
    .returning();
  if (!user) throw new Error('user insert failed');
  return user;
}

export async function createRelayWithEvent(
  db: Db,
  userId: string,
  eventStatus: (typeof events.$inferInsert)['status'] = 'PROCESSING',
) {
  const [relay] = await db
    .insert(relays)
    .values({
      userId,
      name: 'Test relay',
      type: 'webhook_sms',
      ingestToken: `token-${randomUUID()}-${randomUUID()}`,
    })
    .returning();
  if (!relay) throw new Error('relay insert failed');

  const [event] = await db
    .insert(events)
    .values({ relayId: relay.id, userId, source: 'http', status: eventStatus })
    .returning();
  if (!event) throw new Error('event insert failed');

  return { relay, event };
}
