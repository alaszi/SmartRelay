import { and, desc, eq } from 'drizzle-orm';
import type { PaymentProviderName } from '@smartrelay/shared';
import type { Db, Executor } from './client';
import { processedProviderEvents, topups } from './schema';

export type TopupRow = typeof topups.$inferSelect;

export async function createTopup(
  db: Executor,
  input: { userId: string; provider: PaymentProviderName; amountCents: number },
): Promise<TopupRow> {
  const [topup] = await db
    .insert(topups)
    .values({
      userId: input.userId,
      provider: input.provider,
      amountCents: input.amountCents,
      status: 'pending',
    })
    .returning();
  if (!topup) throw new Error('topup insert returned no row');
  return topup;
}

export async function setTopupProviderSession(
  db: Executor,
  topupId: string,
  providerSessionId: string,
): Promise<void> {
  await db.update(topups).set({ providerSessionId }).where(eq(topups.id, topupId));
}

export async function markTopupPaid(
  db: Executor,
  providerSessionId: string,
): Promise<TopupRow | undefined> {
  const [topup] = await db
    .update(topups)
    .set({ status: 'paid' })
    .where(and(eq(topups.providerSessionId, providerSessionId), eq(topups.status, 'pending')))
    .returning();
  return topup;
}

export async function getTopupBySession(
  db: Executor,
  providerSessionId: string,
): Promise<TopupRow | undefined> {
  const [topup] = await db
    .select()
    .from(topups)
    .where(eq(topups.providerSessionId, providerSessionId))
    .limit(1);
  return topup;
}

export async function listTopupsForUser(db: Executor, userId: string): Promise<TopupRow[]> {
  return db.select().from(topups).where(eq(topups.userId, userId)).orderBy(desc(topups.createdAt));
}

/** Webhook idempotency (MASTER_PLAN section 7): a provider event id is processed at most once.
 * Returns false (and records the event) the first time; true on every replay. */
export async function wasProviderEventProcessed(
  db: Db,
  provider: PaymentProviderName,
  eventId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(processedProviderEvents)
      .where(
        and(
          eq(processedProviderEvents.provider, provider),
          eq(processedProviderEvents.eventId, eventId),
        ),
      )
      .limit(1);
    if (existing) return true;
    await tx.insert(processedProviderEvents).values({ provider, eventId });
    return false;
  });
}
