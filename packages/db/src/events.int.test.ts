import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRelayWithEvent, createTestDb, createUser, resetDb } from '../test/helpers';
import { eventPayloads } from './schema';
import type { DbHandle } from './client';
import { createEvent, expireStaleHeldEvents, getEventById, purgeExpiredPayloads } from './events';

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

describe('expireStaleHeldEvents', () => {
  it('expires a held event past its heldUntil deadline (MASTER_PLAN section 7: 48h)', async () => {
    const user = await createUser(handle.db);
    const { relay } = await createRelayWithEvent(handle.db, user.id);
    const held = await createEvent(handle.db, {
      relayId: relay.id,
      userId: user.id,
      source: 'http',
      status: 'HELD_NO_CREDIT',
      heldUntil: new Date(Date.now() - 1000),
    });

    const expired = await expireStaleHeldEvents(handle.db);

    expect(expired.map((e) => e.id)).toContain(held.id);
    expect(await getEventById(handle.db, held.id)).toMatchObject({ status: 'EXPIRED' });
  });

  it('leaves a held event with a future heldUntil alone', async () => {
    const user = await createUser(handle.db);
    const { relay } = await createRelayWithEvent(handle.db, user.id);
    const held = await createEvent(handle.db, {
      relayId: relay.id,
      userId: user.id,
      source: 'http',
      status: 'HELD_NO_CREDIT',
      heldUntil: new Date(Date.now() + 48 * 3600 * 1000),
    });

    const expired = await expireStaleHeldEvents(handle.db);

    expect(expired.map((e) => e.id)).not.toContain(held.id);
    expect(await getEventById(handle.db, held.id)).toMatchObject({ status: 'HELD_NO_CREDIT' });
  });

  it('leaves non-held events alone regardless of heldUntil', async () => {
    const user = await createUser(handle.db);
    const { relay } = await createRelayWithEvent(handle.db, user.id);
    const success = await createEvent(handle.db, {
      relayId: relay.id,
      userId: user.id,
      source: 'http',
      status: 'QUEUED',
    });

    await expireStaleHeldEvents(handle.db);

    expect(await getEventById(handle.db, success.id)).toMatchObject({ status: 'QUEUED' });
  });
});

describe('purgeExpiredPayloads', () => {
  it('deletes payload content past its purge_after, but not the event row (MASTER_PLAN section 7: 30 days, metadata retained)', async () => {
    const user = await createUser(handle.db);
    const { relay } = await createRelayWithEvent(handle.db, user.id);
    const event = await createEvent(handle.db, {
      relayId: relay.id,
      userId: user.id,
      source: 'http',
      status: 'SUCCESS',
      payloadIn: { secret: 'do-not-keep-this' },
    });
    await handle.db.execute(
      sql`UPDATE event_payloads SET purge_after = now() - interval '1 second' WHERE event_id = ${event.id}`,
    );

    const purged = await purgeExpiredPayloads(handle.db);

    expect(purged).toBeGreaterThanOrEqual(1);
    expect(
      await handle.db.select().from(eventPayloads).where(eq(eventPayloads.eventId, event.id)),
    ).toHaveLength(0);
    expect(await getEventById(handle.db, event.id)).toMatchObject({ id: event.id });
  });

  it('does not delete payload content that has not reached purge_after yet', async () => {
    const user = await createUser(handle.db);
    const { relay } = await createRelayWithEvent(handle.db, user.id);
    const event = await createEvent(handle.db, {
      relayId: relay.id,
      userId: user.id,
      source: 'http',
      status: 'SUCCESS',
      payloadIn: { keep: 'me' },
    });

    await purgeExpiredPayloads(handle.db);

    expect(
      await handle.db.select().from(eventPayloads).where(eq(eventPayloads.eventId, event.id)),
    ).toHaveLength(1);
  });
});
