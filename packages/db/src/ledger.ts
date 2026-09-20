import { eq, sql } from 'drizzle-orm';
import type { LedgerKind } from '@smartrelay/shared';
import type { Db, Executor, Tx } from './client';
import { creditAccounts, creditLedger, events } from './schema';

export type LedgerRow = typeof creditLedger.$inferSelect;

export type LedgerErrorCode =
  'INVALID_AMOUNT' | 'IDEMPOTENCY_CONFLICT' | 'EVENT_NOT_FOUND' | 'EVENT_NOT_CHARGEABLE';

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;

  constructor(code: LedgerErrorCode, message: string) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

export interface LedgerEntryInput {
  userId: string;
  /** Signed: positive adds credit, negative removes it. */
  deltaMicro: bigint;
  kind: LedgerKind;
  refType?: string;
  refId?: string;
  /** Replaying the same key never changes the balance a second time. */
  idempotencyKey: string;
}

export interface LedgerResult {
  entry: LedgerRow;
  /** True when the idempotency key was already recorded: nothing was written this time. */
  duplicate: boolean;
}

function assertValidEntry(input: LedgerEntryInput): void {
  if (input.idempotencyKey.length === 0) {
    throw new LedgerError('INVALID_AMOUNT', 'idempotencyKey must not be empty');
  }
  if (input.deltaMicro === 0n) {
    throw new LedgerError('INVALID_AMOUNT', 'delta must not be zero');
  }
  if (input.kind === 'topup' && input.deltaMicro < 0n) {
    throw new LedgerError('INVALID_AMOUNT', 'a topup must add credit');
  }
  if (input.kind === 'charge' && input.deltaMicro > 0n) {
    throw new LedgerError('INVALID_AMOUNT', 'a charge must remove credit');
  }
}

/**
 * Core ledger write. Must run inside a transaction: it locks the user's credit_accounts row with
 * FOR UPDATE, so every writer for one user is serialized. The idempotency check happens after the
 * lock is held, which is what makes concurrent replays of one key safe (READ COMMITTED gives a
 * fresh snapshot per statement, so the winner's insert is visible once the lock is released).
 * The balance may go below zero: in-flight jobs are allowed to finish (decision D11).
 */
export async function applyLedgerEntry(tx: Tx, input: LedgerEntryInput): Promise<LedgerResult> {
  assertValidEntry(input);

  await tx
    .insert(creditAccounts)
    .values({ userId: input.userId })
    .onConflictDoNothing({ target: creditAccounts.userId });

  const [account] = await tx
    .select()
    .from(creditAccounts)
    .where(eq(creditAccounts.userId, input.userId))
    .for('update');
  if (!account) throw new Error('credit account disappeared while locked');

  const [existing] = await tx
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.idempotencyKey, input.idempotencyKey))
    .limit(1);
  if (existing) {
    if (existing.userId !== input.userId || existing.deltaMicro !== input.deltaMicro) {
      throw new LedgerError(
        'IDEMPOTENCY_CONFLICT',
        'idempotency key was already used for a different entry',
      );
    }
    return { entry: existing, duplicate: true };
  }

  const balanceAfter = account.balanceMicro + input.deltaMicro;

  const [entry] = await tx
    .insert(creditLedger)
    .values({
      userId: input.userId,
      deltaMicro: input.deltaMicro,
      kind: input.kind,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      idempotencyKey: input.idempotencyKey,
      balanceAfterMicro: balanceAfter,
    })
    .returning();
  if (!entry) throw new Error('ledger insert returned no row');

  await tx
    .update(creditAccounts)
    .set({ balanceMicro: balanceAfter })
    .where(eq(creditAccounts.userId, input.userId));

  return { entry, duplicate: false };
}

export async function getBalance(db: Executor, userId: string): Promise<bigint> {
  const [account] = await db
    .select({ balanceMicro: creditAccounts.balanceMicro })
    .from(creditAccounts)
    .where(eq(creditAccounts.userId, userId))
    .limit(1);
  return account?.balanceMicro ?? 0n;
}

/** Credits a paid top-up. `providerSessionId` makes provider retries and replays a no-op. */
export function creditTopup(
  db: Db,
  input: { userId: string; amountMicro: bigint; providerSessionId: string; topupId?: string },
): Promise<LedgerResult> {
  return db.transaction((tx) =>
    applyLedgerEntry(tx, {
      userId: input.userId,
      deltaMicro: input.amountMicro,
      kind: 'topup',
      refType: 'topup',
      ...(input.topupId === undefined ? {} : { refId: input.topupId }),
      idempotencyKey: `topup:${input.providerSessionId}`,
    }),
  );
}

/** Manual correction from the admin scripts. The caller supplies the idempotency key. */
export function adjustBalance(
  db: Db,
  input: {
    userId: string;
    deltaMicro: bigint;
    kind?: 'adjustment' | 'refund';
    reason: string;
    idempotencyKey: string;
  },
): Promise<LedgerResult> {
  return db.transaction((tx) =>
    applyLedgerEntry(tx, {
      userId: input.userId,
      deltaMicro: input.deltaMicro,
      kind: input.kind ?? 'adjustment',
      refType: 'admin',
      refId: input.reason,
      idempotencyKey: input.idempotencyKey,
    }),
  );
}

const CHARGEABLE_STATUSES = new Set(['RECEIVED', 'QUEUED', 'PROCESSING', 'SUCCESS']);

export interface ChargeEventResult {
  /** False when this event had already been charged (a replay). */
  charged: boolean;
  entry: LedgerRow;
}

/**
 * Bills one successful delivery in a single transaction: ledger charge (key `charge:<eventId>`),
 * balance update, and event -> SUCCESS with its cost. Locks the event row first and the account
 * row second, always in that order. A replay for an already charged event changes nothing.
 */
export async function chargeEvent(
  db: Db,
  input: { eventId: string; priceMicro: bigint; finalStatusCode?: number },
): Promise<ChargeEventResult> {
  if (input.priceMicro <= 0n) {
    throw new LedgerError('INVALID_AMOUNT', 'price must be positive');
  }

  return db.transaction(async (tx) => {
    const [event] = await tx
      .select()
      .from(events)
      .where(eq(events.id, input.eventId))
      .for('update');
    if (!event) throw new LedgerError('EVENT_NOT_FOUND', 'event does not exist');
    if (!CHARGEABLE_STATUSES.has(event.status)) {
      throw new LedgerError(
        'EVENT_NOT_CHARGEABLE',
        `event in status ${event.status} is not billable`,
      );
    }

    const { entry, duplicate } = await applyLedgerEntry(tx, {
      userId: event.userId,
      deltaMicro: -input.priceMicro,
      kind: 'charge',
      refType: 'event',
      refId: event.id,
      idempotencyKey: `charge:${event.id}`,
    });

    if (!duplicate || event.status !== 'SUCCESS') {
      await tx
        .update(events)
        .set({
          status: 'SUCCESS',
          costMicro: input.priceMicro,
          finalStatusCode: input.finalStatusCode ?? null,
          finishedAt: sql`now()`,
        })
        .where(eq(events.id, event.id));
    }

    return { charged: !duplicate, entry };
  });
}
