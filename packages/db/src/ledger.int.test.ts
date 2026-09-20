import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, createRelayWithEvent, createUser, resetDb } from '../test/helpers';
import type { DbHandle } from './client';
import {
  adjustBalance,
  applyLedgerEntry,
  chargeEvent,
  creditTopup,
  getBalance,
  LedgerError,
} from './ledger';
import { creditAccounts, creditLedger, events, users } from './schema';

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

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function ledgerRows(userId: string) {
  return handle.db
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.userId, userId))
    .orderBy(asc(creditLedger.seq));
}

async function topUp(userId: string, amountMicro: bigint, session = `cs_${Math.random()}`) {
  return creditTopup(handle.db, { userId, amountMicro, providerSessionId: session });
}

describe('basic ledger writes', () => {
  it('returns a zero balance for a user without an account', async () => {
    const user = await createUser(handle.db);
    expect(await getBalance(handle.db, user.id)).toBe(0n);
  });

  it('credits a top-up and records balance_after', async () => {
    const user = await createUser(handle.db);
    const { entry, duplicate } = await topUp(user.id, 5_000_000n, 'cs_1');

    expect(duplicate).toBe(false);
    expect(entry.kind).toBe('topup');
    expect(entry.deltaMicro).toBe(5_000_000n);
    expect(entry.balanceAfterMicro).toBe(5_000_000n);
    expect(entry.idempotencyKey).toBe('topup:cs_1');
    expect(await getBalance(handle.db, user.id)).toBe(5_000_000n);
  });

  it('applies adjustments and refunds in both directions', async () => {
    const user = await createUser(handle.db);
    await topUp(user.id, 1_000_000n);
    await adjustBalance(handle.db, {
      userId: user.id,
      deltaMicro: -250_000n,
      reason: 'goodwill correction',
      idempotencyKey: 'adj:1',
    });
    await adjustBalance(handle.db, {
      userId: user.id,
      deltaMicro: 100_000n,
      kind: 'refund',
      reason: 'refund of charge',
      idempotencyKey: 'adj:2',
    });

    expect(await getBalance(handle.db, user.id)).toBe(850_000n);
    const rows = await ledgerRows(user.id);
    expect(rows.map((row) => row.kind)).toEqual(['topup', 'adjustment', 'refund']);
    expect(rows[1]?.refType).toBe('admin');
    expect(rows[1]?.refId).toBe('goodwill correction');
  });

  it('lets a charge take the balance below zero (decision D11)', async () => {
    const user = await createUser(handle.db);
    const { event } = await createRelayWithEvent(handle.db, user.id);
    await topUp(user.id, 3_000n);

    await chargeEvent(handle.db, { eventId: event.id, priceMicro: 5_000n });

    expect(await getBalance(handle.db, user.id)).toBe(-2_000n);
  });
});

describe('input validation', () => {
  it('rejects a zero delta, a negative top-up and a positive charge before touching the database', async () => {
    const user = await createUser(handle.db);
    const attempt = (deltaMicro: bigint, kind: 'topup' | 'charge' | 'adjustment') =>
      handle.db.transaction((tx) =>
        applyLedgerEntry(tx, {
          userId: user.id,
          deltaMicro,
          kind,
          idempotencyKey: `k:${kind}:${deltaMicro}`,
        }),
      );

    await expect(attempt(0n, 'adjustment')).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    await expect(attempt(-1n, 'topup')).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    await expect(attempt(1n, 'charge')).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    expect(await ledgerRows(user.id)).toHaveLength(0);
  });

  it('rejects an empty idempotency key', async () => {
    const user = await createUser(handle.db);
    await expect(
      handle.db.transaction((tx) =>
        applyLedgerEntry(tx, {
          userId: user.id,
          deltaMicro: 1n,
          kind: 'topup',
          idempotencyKey: '',
        }),
      ),
    ).rejects.toBeInstanceOf(LedgerError);
  });

  it('rejects a non-positive charge price', async () => {
    await expect(
      chargeEvent(handle.db, { eventId: '00000000-0000-0000-0000-000000000000', priceMicro: 0n }),
    ).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
  });

  it('enforces the delta sign in the database itself, not just in the function', async () => {
    const user = await createUser(handle.db);
    const insert = (kind: string, delta: number) =>
      handle.db.execute(sql`
        INSERT INTO credit_ledger (user_id, delta_micro, kind, idempotency_key, balance_after_micro)
        VALUES (${user.id}, ${delta}, ${sql.raw(`'${kind}'`)}, ${`raw:${kind}:${delta}`}, 0)
      `);

    await expect(insert('charge', 5)).rejects.toThrow();
    await expect(insert('topup', -5)).rejects.toThrow();
    await expect(insert('adjustment', 0)).rejects.toThrow();
  });
});

describe('idempotency', () => {
  it('replaying a key returns the original entry and does not change the balance', async () => {
    const user = await createUser(handle.db);
    const first = await topUp(user.id, 10_000_000n, 'cs_replay');
    const second = await topUp(user.id, 10_000_000n, 'cs_replay');

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);
    expect(await getBalance(handle.db, user.id)).toBe(10_000_000n);
    expect(await ledgerRows(user.id)).toHaveLength(1);
  });

  it('refuses to reuse a key for a different amount or a different user', async () => {
    const alice = await createUser(handle.db);
    const bob = await createUser(handle.db);
    await topUp(alice.id, 5_000_000n, 'cs_shared');

    await expect(topUp(alice.id, 9_000_000n, 'cs_shared')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    await expect(topUp(bob.id, 5_000_000n, 'cs_shared')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(await getBalance(handle.db, alice.id)).toBe(5_000_000n);
    expect(await getBalance(handle.db, bob.id)).toBe(0n);
  });

  it('applies a key exactly once when 25 callers race with it', async () => {
    const user = await createUser(handle.db);

    const results = await Promise.all(
      Array.from({ length: 25 }, () => topUp(user.id, 2_000_000n, 'cs_race')),
    );

    expect(results.filter((result) => !result.duplicate)).toHaveLength(1);
    expect(results.filter((result) => result.duplicate)).toHaveLength(24);
    expect(await getBalance(handle.db, user.id)).toBe(2_000_000n);
    expect(await ledgerRows(user.id)).toHaveLength(1);
  });
});

describe('concurrency and row locking', () => {
  it('keeps the balance exact and the balance_after chain unbroken under 100 parallel writes', async () => {
    const user = await createUser(handle.db);
    await topUp(user.id, 1_000_000n, 'cs_seed');

    // 60 charges of 5_000, 40 top-ups of 3_000 -> net -180_000, expected balance 820_000.
    const writes = [
      ...Array.from({ length: 60 }, (_, i) =>
        handle.db.transaction((tx) =>
          applyLedgerEntry(tx, {
            userId: user.id,
            deltaMicro: -5_000n,
            kind: 'charge',
            idempotencyKey: `charge:parallel:${i}`,
          }),
        ),
      ),
      ...Array.from({ length: 40 }, (_, i) => topUp(user.id, 3_000n, `cs_parallel_${i}`)),
    ];
    await Promise.all(writes);

    expect(await getBalance(handle.db, user.id)).toBe(820_000n);

    const rows = await ledgerRows(user.id);
    expect(rows).toHaveLength(101);
    let running = 0n;
    for (const row of rows) {
      running += row.deltaMicro;
      expect(row.balanceAfterMicro).toBe(running);
    }
    expect(running).toBe(820_000n);
  });

  it('never mixes up balances of different users written in parallel', async () => {
    const users_ = await Promise.all(Array.from({ length: 5 }, () => createUser(handle.db)));

    await Promise.all(
      users_.flatMap((user, index) =>
        Array.from({ length: 10 }, (_, i) =>
          topUp(user.id, BigInt((index + 1) * 1_000), `cs_multi_${index}_${i}`),
        ),
      ),
    );

    for (const [index, user] of users_.entries()) {
      expect(await getBalance(handle.db, user.id)).toBe(BigInt((index + 1) * 10_000));
    }
  });

  it('blocks a second writer on the account row until the first transaction ends', async () => {
    const user = await createUser(handle.db);
    await topUp(user.id, 1_000n, 'cs_lock_seed');

    let releaseFirst!: () => void;
    const firstMayCommit = new Promise<void>((resolve) => (releaseFirst = resolve));
    let firstHoldsLock!: () => void;
    const firstLocked = new Promise<void>((resolve) => (firstHoldsLock = resolve));

    const first = handle.db.transaction(async (tx) => {
      await applyLedgerEntry(tx, {
        userId: user.id,
        deltaMicro: 100n,
        kind: 'topup',
        idempotencyKey: 'lock:first',
      });
      firstHoldsLock();
      await firstMayCommit;
    });
    await firstLocked;

    let secondFinished = false;
    const second = topUp(user.id, 200n, 'lock_second').then(() => {
      secondFinished = true;
    });

    await delay(300);
    expect(secondFinished).toBe(false);

    releaseFirst();
    await Promise.all([first, second]);

    expect(secondFinished).toBe(true);
    expect(await getBalance(handle.db, user.id)).toBe(1_300n);
    const rows = await ledgerRows(user.id);
    expect(rows.map((row) => row.balanceAfterMicro)).toEqual([1_000n, 1_100n, 1_300n]);
  });

  it('leaves no trace when the surrounding transaction rolls back', async () => {
    const user = await createUser(handle.db);
    await topUp(user.id, 1_000n, 'cs_rollback_seed');

    await expect(
      handle.db.transaction(async (tx) => {
        await applyLedgerEntry(tx, {
          userId: user.id,
          deltaMicro: -400n,
          kind: 'charge',
          idempotencyKey: 'charge:rolled-back',
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await getBalance(handle.db, user.id)).toBe(1_000n);
    expect(await ledgerRows(user.id)).toHaveLength(1);
  });
});

describe('chargeEvent: double-charge prevention', () => {
  it('charges once and marks the event SUCCESS with its cost', async () => {
    const user = await createUser(handle.db);
    const { event } = await createRelayWithEvent(handle.db, user.id);
    await topUp(user.id, 1_000_000n);

    const result = await chargeEvent(handle.db, {
      eventId: event.id,
      priceMicro: 25_000n,
      finalStatusCode: 200,
    });

    expect(result.charged).toBe(true);
    expect(result.entry.deltaMicro).toBe(-25_000n);
    expect(result.entry.idempotencyKey).toBe(`charge:${event.id}`);
    expect(result.entry.refType).toBe('event');
    expect(result.entry.refId).toBe(event.id);
    expect(await getBalance(handle.db, user.id)).toBe(975_000n);

    const [after] = await handle.db.select().from(events).where(eq(events.id, event.id));
    expect(after?.status).toBe('SUCCESS');
    expect(after?.costMicro).toBe(25_000n);
    expect(after?.finalStatusCode).toBe(200);
    expect(after?.finishedAt).toBeInstanceOf(Date);
  });

  it('bills exactly once when 20 workers report the same success concurrently', async () => {
    const user = await createUser(handle.db);
    const { event } = await createRelayWithEvent(handle.db, user.id);
    await topUp(user.id, 1_000_000n);

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        chargeEvent(handle.db, { eventId: event.id, priceMicro: 5_000n, finalStatusCode: 200 }),
      ),
    );

    expect(results.filter((result) => result.charged)).toHaveLength(1);
    expect(await getBalance(handle.db, user.id)).toBe(995_000n);
    const charges = (await ledgerRows(user.id)).filter((row) => row.kind === 'charge');
    expect(charges).toHaveLength(1);
  });

  it('does nothing on a later replay of an already billed event', async () => {
    const user = await createUser(handle.db);
    const { event } = await createRelayWithEvent(handle.db, user.id);
    await topUp(user.id, 100_000n);

    await chargeEvent(handle.db, { eventId: event.id, priceMicro: 5_000n, finalStatusCode: 200 });
    const [billed] = await handle.db.select().from(events).where(eq(events.id, event.id));
    const replay = await chargeEvent(handle.db, {
      eventId: event.id,
      priceMicro: 5_000n,
      finalStatusCode: 201,
    });

    expect(replay.charged).toBe(false);
    expect(await getBalance(handle.db, user.id)).toBe(95_000n);
    const [afterReplay] = await handle.db.select().from(events).where(eq(events.id, event.id));
    expect(afterReplay?.finalStatusCode).toBe(200);
    expect(afterReplay?.finishedAt).toEqual(billed?.finishedAt);
  });

  it('refuses to bill events that did not succeed', async () => {
    const user = await createUser(handle.db);
    await topUp(user.id, 100_000n);

    for (const status of [
      'FAILED',
      'REJECTED',
      'DROPPED_LOOP',
      'HELD_NO_CREDIT',
      'EXPIRED',
    ] as const) {
      const { event } = await createRelayWithEvent(handle.db, user.id, status);
      await expect(
        chargeEvent(handle.db, { eventId: event.id, priceMicro: 5_000n }),
      ).rejects.toMatchObject({ code: 'EVENT_NOT_CHARGEABLE' });
    }

    expect(await getBalance(handle.db, user.id)).toBe(100_000n);
    expect((await ledgerRows(user.id)).filter((row) => row.kind === 'charge')).toHaveLength(0);
  });

  it('reports an unknown event', async () => {
    await expect(
      chargeEvent(handle.db, {
        eventId: '00000000-0000-0000-0000-000000000000',
        priceMicro: 5_000n,
      }),
    ).rejects.toMatchObject({ code: 'EVENT_NOT_FOUND' });
  });

  it('refuses a replay with a different price instead of silently ignoring it', async () => {
    const user = await createUser(handle.db);
    const { event } = await createRelayWithEvent(handle.db, user.id);
    await chargeEvent(handle.db, { eventId: event.id, priceMicro: 5_000n });

    await expect(
      chargeEvent(handle.db, { eventId: event.id, priceMicro: 25_000n }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
});

describe('append-only ledger', () => {
  it('rejects UPDATE of amounts and DELETE', async () => {
    const user = await createUser(handle.db);
    const { entry } = await topUp(user.id, 5_000n);

    await expect(
      handle.db.execute(sql`UPDATE credit_ledger SET delta_micro = 999 WHERE id = ${entry.id}`),
    ).rejects.toThrow();
    await expect(
      handle.db.execute(
        sql`UPDATE credit_ledger SET balance_after_micro = 1 WHERE id = ${entry.id}`,
      ),
    ).rejects.toThrow();
    await expect(
      handle.db.execute(sql`DELETE FROM credit_ledger WHERE id = ${entry.id}`),
    ).rejects.toThrow();

    const [row] = await handle.db.select().from(creditLedger).where(eq(creditLedger.id, entry.id));
    expect(row?.deltaMicro).toBe(5_000n);
  });

  it('keeps ledger rows, anonymized, when the user is deleted', async () => {
    const user = await createUser(handle.db);
    const { entry } = await topUp(user.id, 5_000n, 'cs_delete_user');

    await handle.db.delete(users).where(eq(users.id, user.id));

    const [row] = await handle.db.select().from(creditLedger).where(eq(creditLedger.id, entry.id));
    expect(row).toBeDefined();
    expect(row?.userId).toBeNull();
    expect(row?.deltaMicro).toBe(5_000n);
    const accounts = await handle.db
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.userId, user.id));
    expect(accounts).toHaveLength(0);
  });

  it('does not allow re-attaching an anonymized row to a user', async () => {
    const user = await createUser(handle.db);
    const other = await createUser(handle.db);
    const { entry } = await topUp(user.id, 5_000n, 'cs_reattach');
    await handle.db.delete(users).where(eq(users.id, user.id));

    await expect(
      handle.db.execute(sql`UPDATE credit_ledger SET user_id = ${other.id} WHERE id = ${entry.id}`),
    ).rejects.toThrow();
  });
});
