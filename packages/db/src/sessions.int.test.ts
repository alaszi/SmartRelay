import { hashToken } from '@smartrelay/engine';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, createUser, resetDb } from '../test/helpers';
import type { DbHandle } from './client';
import {
  createSession,
  deleteExpiredSessions,
  deleteOtherSessions,
  deleteSession,
  findValidSession,
} from './sessions';

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

describe('createSession / findValidSession', () => {
  it('creates a session and finds it by its token hash', async () => {
    const user = await createUser(handle.db);
    const hash = hashToken('raw-session-token');
    const session = await createSession(handle.db, { idHash: hash, userId: user.id });

    expect(session.id).toBe(hash);
    const found = await findValidSession(handle.db, hash);
    expect(found?.userId).toBe(user.id);
    expect(found?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('returns undefined for an unknown token', async () => {
    expect(await findValidSession(handle.db, hashToken('never-issued'))).toBeUndefined();
  });

  it('does not return an expired session', async () => {
    const user = await createUser(handle.db);
    const hash = hashToken('expired-session');
    await createSession(handle.db, { idHash: hash, userId: user.id });
    await handle.db.execute(
      sql`UPDATE sessions SET expires_at = now() - interval '1 hour' WHERE id = ${hash}`,
    );

    expect(await findValidSession(handle.db, hash)).toBeUndefined();
  });
});

describe('deleteSession', () => {
  it('removes exactly that session and leaves others intact', async () => {
    const user = await createUser(handle.db);
    const a = hashToken('a');
    const b = hashToken('b');
    await createSession(handle.db, { idHash: a, userId: user.id });
    await createSession(handle.db, { idHash: b, userId: user.id });

    await deleteSession(handle.db, a);

    expect(await findValidSession(handle.db, a)).toBeUndefined();
    expect(await findValidSession(handle.db, b)).toBeDefined();
  });
});

describe('deleteOtherSessions (rotation on login)', () => {
  it('keeps only the given session for the user', async () => {
    const user = await createUser(handle.db);
    const keep = hashToken('keep');
    const drop1 = hashToken('drop1');
    const drop2 = hashToken('drop2');
    await createSession(handle.db, { idHash: keep, userId: user.id });
    await createSession(handle.db, { idHash: drop1, userId: user.id });
    await createSession(handle.db, { idHash: drop2, userId: user.id });

    await deleteOtherSessions(handle.db, user.id, keep);

    expect(await findValidSession(handle.db, keep)).toBeDefined();
    expect(await findValidSession(handle.db, drop1)).toBeUndefined();
    expect(await findValidSession(handle.db, drop2)).toBeUndefined();
  });

  it("does not touch another user's sessions", async () => {
    const alice = await createUser(handle.db);
    const bob = await createUser(handle.db);
    const aliceSession = hashToken('alice-session');
    const bobSession = hashToken('bob-session');
    await createSession(handle.db, { idHash: aliceSession, userId: alice.id });
    await createSession(handle.db, { idHash: bobSession, userId: bob.id });

    await deleteOtherSessions(handle.db, alice.id);

    expect(await findValidSession(handle.db, aliceSession)).toBeUndefined();
    expect(await findValidSession(handle.db, bobSession)).toBeDefined();
  });

  it('removes every session for the user when no session is kept (logout everywhere)', async () => {
    const user = await createUser(handle.db);
    const a = hashToken('logout-a');
    const b = hashToken('logout-b');
    await createSession(handle.db, { idHash: a, userId: user.id });
    await createSession(handle.db, { idHash: b, userId: user.id });

    await deleteOtherSessions(handle.db, user.id);

    expect(await findValidSession(handle.db, a)).toBeUndefined();
    expect(await findValidSession(handle.db, b)).toBeUndefined();
  });
});

describe('deleteExpiredSessions', () => {
  it('removes only expired sessions', async () => {
    const user = await createUser(handle.db);
    const fresh = hashToken('fresh');
    const stale = hashToken('stale');
    await createSession(handle.db, { idHash: fresh, userId: user.id });
    await createSession(handle.db, { idHash: stale, userId: user.id });
    await handle.db.execute(
      sql`UPDATE sessions SET expires_at = now() - interval '1 hour' WHERE id = ${stale}`,
    );

    await deleteExpiredSessions(handle.db);

    expect(await findValidSession(handle.db, fresh)).toBeDefined();
    const rows = await handle.db.execute(sql`SELECT id FROM sessions WHERE id = ${stale}`);
    expect(rows.rows).toHaveLength(0);
  });
});

describe('cascade delete', () => {
  it('removes sessions when the user is deleted', async () => {
    const user = await createUser(handle.db);
    const hash = hashToken('cascade-session');
    await createSession(handle.db, { idHash: hash, userId: user.id });

    await handle.db.execute(sql`DELETE FROM users WHERE id = ${user.id}`);

    expect(await findValidSession(handle.db, hash)).toBeUndefined();
  });
});
