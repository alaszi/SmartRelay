import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, createUser, resetDb } from '../test/helpers';
import type { DbHandle } from './client';
import { clearNotification, tryRecordNotification } from './notifications';

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

describe('tryRecordNotification', () => {
  it('returns true the first time, false on a repeat with the same dedupe key', async () => {
    const user = await createUser(handle.db);

    const first = await tryRecordNotification(handle.db, {
      userId: user.id,
      kind: 'low-balance',
      dedupeKey: 'low-balance',
    });
    const second = await tryRecordNotification(handle.db, {
      userId: user.id,
      kind: 'low-balance',
      dedupeKey: 'low-balance',
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('dedupes per user: the same key for a different user sends independently', async () => {
    const a = await createUser(handle.db);
    const b = await createUser(handle.db);

    await tryRecordNotification(handle.db, { userId: a.id, kind: 'x', dedupeKey: 'shared-key' });
    const forB = await tryRecordNotification(handle.db, {
      userId: b.id,
      kind: 'x',
      dedupeKey: 'shared-key',
    });

    expect(forB).toBe(true);
  });

  it('a different dedupe key for the same user sends independently', async () => {
    const user = await createUser(handle.db);

    await tryRecordNotification(handle.db, { userId: user.id, kind: 'x', dedupeKey: 'cycle-1' });
    const nextCycle = await tryRecordNotification(handle.db, {
      userId: user.id,
      kind: 'x',
      dedupeKey: 'cycle-2',
    });

    expect(nextCycle).toBe(true);
  });
});

describe('clearNotification', () => {
  it('lets a cleared dedupe key send again (e.g. low-balance after a top-up)', async () => {
    const user = await createUser(handle.db);
    await tryRecordNotification(handle.db, {
      userId: user.id,
      kind: 'x',
      dedupeKey: 'low-balance',
    });

    await clearNotification(handle.db, { userId: user.id, dedupeKey: 'low-balance' });
    const afterClear = await tryRecordNotification(handle.db, {
      userId: user.id,
      kind: 'x',
      dedupeKey: 'low-balance',
    });

    expect(afterClear).toBe(true);
  });
});
