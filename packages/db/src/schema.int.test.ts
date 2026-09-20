import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRelayWithEvent, createTestDb, createUser, resetDb } from '../test/helpers';
import type { DbHandle } from './client';
import { getPriceMicro, seedPricing } from './pricing';
import { deliveryAttempts, eventPayloads, events, pricing, relays, users } from './schema';

let handle: DbHandle;

beforeAll(() => {
  handle = createTestDb();
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await resetDb(handle.db);
});

describe('pricing seed', () => {
  it('seeds the three prices from the plan', async () => {
    expect(await getPriceMicro(handle.db, 'relay_http')).toBe(5_000n);
    expect(await getPriceMicro(handle.db, 'calendar_event')).toBe(10_000n);
    expect(await getPriceMicro(handle.db, 'sms_dispatch')).toBe(25_000n);
  });

  it('is idempotent and never overwrites a price the owner changed', async () => {
    await handle.db
      .update(pricing)
      .set({ priceMicro: 30_000n })
      .where(eq(pricing.kind, 'sms_dispatch'));

    await seedPricing(handle.db);
    await seedPricing(handle.db);

    expect(await getPriceMicro(handle.db, 'sms_dispatch')).toBe(30_000n);
    expect(await handle.db.select().from(pricing)).toHaveLength(3);
  });

  it('rejects a zero or negative price at the database level', async () => {
    await expect(
      handle.db.update(pricing).set({ priceMicro: 0n }).where(eq(pricing.kind, 'relay_http')),
    ).rejects.toThrow();
  });
});

describe('users', () => {
  it('treats email as case-insensitive and unique', async () => {
    await createUser(handle.db, 'Alice@Example.com');

    await expect(createUser(handle.db, 'alice@example.COM')).rejects.toThrow();

    const [found] = await handle.db
      .select()
      .from(users)
      .where(eq(users.email, 'ALICE@example.com'));
    expect(found?.email).toBe('Alice@Example.com');
  });

  it('defaults the timezone to Europe/Bucharest', async () => {
    const user = await createUser(handle.db);
    expect(user.timezone).toBe('Europe/Bucharest');
  });
});

describe('relays and events', () => {
  it('requires unique ingest tokens', async () => {
    const user = await createUser(handle.db);
    const { relay } = await createRelayWithEvent(handle.db, user.id);

    await expect(
      handle.db.insert(relays).values({
        userId: user.id,
        name: 'Clone',
        type: 'chat_relay',
        ingestToken: relay.ingestToken,
      }),
    ).rejects.toThrow();
  });

  it('applies the documented defaults', async () => {
    const user = await createUser(handle.db);
    const { relay, event } = await createRelayWithEvent(handle.db, user.id, 'RECEIVED');

    expect(relay.status).toBe('active');
    expect(relay.smsMode).toBe('byo');
    expect(relay.configPublic).toEqual({});
    expect(relay.configSecret).toBeNull();
    expect(event.status).toBe('RECEIVED');
    expect(event.costMicro).toBe(0n);
  });

  it('deletes events, payloads and attempts with their relay', async () => {
    const user = await createUser(handle.db);
    const { relay, event } = await createRelayWithEvent(handle.db, user.id);
    await handle.db.insert(eventPayloads).values({
      eventId: event.id,
      payloadIn: { hello: 'world' },
      purgeAfter: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    });
    await handle.db.insert(deliveryAttempts).values({ eventId: event.id, attemptNo: 1, ok: true });

    await handle.db.delete(relays).where(eq(relays.id, relay.id));

    expect(await handle.db.select().from(events)).toHaveLength(0);
    expect(await handle.db.select().from(eventPayloads)).toHaveLength(0);
    expect(await handle.db.select().from(deliveryAttempts)).toHaveLength(0);
  });

  it('allows one attempt number per event only', async () => {
    const user = await createUser(handle.db);
    const { event } = await createRelayWithEvent(handle.db, user.id);
    await handle.db.insert(deliveryAttempts).values({ eventId: event.id, attemptNo: 1, ok: false });

    await expect(
      handle.db.insert(deliveryAttempts).values({ eventId: event.id, attemptNo: 1, ok: false }),
    ).rejects.toThrow();
  });
});

describe('event_payloads', () => {
  it('rejects a response excerpt larger than 8 KB', async () => {
    const user = await createUser(handle.db);
    const { event } = await createRelayWithEvent(handle.db, user.id);

    await expect(
      handle.db.insert(eventPayloads).values({
        eventId: event.id,
        responseExcerpt: 'x'.repeat(8193),
        purgeAfter: new Date(),
      }),
    ).rejects.toThrow();

    await expect(
      handle.db.insert(eventPayloads).values({
        eventId: event.id,
        responseExcerpt: 'x'.repeat(8192),
        purgeAfter: new Date(),
      }),
    ).resolves.toBeDefined();
  });

  it('measures the limit in bytes, not characters', async () => {
    const user = await createUser(handle.db);
    const { event } = await createRelayWithEvent(handle.db, user.id);

    // 4200 two-byte characters = 8400 bytes, which is over the limit despite being < 8192 chars.
    await expect(
      handle.db.insert(eventPayloads).values({
        eventId: event.id,
        responseExcerpt: 'ș'.repeat(4200),
        purgeAfter: new Date(),
      }),
    ).rejects.toThrow();
  });
});

describe('ids', () => {
  it('generates uuid primary keys', async () => {
    const user = await createUser(handle.db, `${randomUUID()}@example.com`);
    expect(user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
