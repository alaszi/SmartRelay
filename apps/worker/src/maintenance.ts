import {
  creditAccounts,
  expireStaleHeldEvents,
  findUserById,
  purgeExpiredPayloads,
  tryRecordNotification,
} from '@smartrelay/db';
import { lt } from 'drizzle-orm';
import type { WorkerContext } from './context';

const LOW_BALANCE_THRESHOLD_MICRO = 1_000_000n; // EUR 1.00
const LOW_BALANCE_DEDUPE_KEY = 'low-balance';
const HELD_EXPIRED_KIND = 'held-expired';

/** Maintenance job (every 5 min): expires held events past their deadline, one summary email
 * per affected user. */
export async function runHeldExpiryJob(ctx: WorkerContext): Promise<number> {
  const expired = await expireStaleHeldEvents(ctx.db);
  if (expired.length === 0) return 0;

  const byUser = new Map<string, number>();
  for (const event of expired) {
    byUser.set(event.userId, (byUser.get(event.userId) ?? 0) + 1);
  }

  for (const [userId, count] of byUser) {
    const dedupeKey = `${HELD_EXPIRED_KIND}:${new Date().toISOString().slice(0, 10)}`;
    const shouldSend = await tryRecordNotification(ctx.db, {
      userId,
      kind: HELD_EXPIRED_KIND,
      dedupeKey,
    });
    if (!shouldSend) continue;
    const user = await findUserById(ctx.db, userId);
    if (!user) continue;
    await ctx.mailer.send({
      to: user.email,
      subject: 'SmartRelay: some events expired without delivery',
      text: `${count} event(s) were held for lack of credit and have now expired without being delivered.`,
    });
  }
  return expired.length;
}

/** Maintenance job (daily, GDPR retention): purges event_payloads content past 30 days. */
export function runRetentionPurgeJob(ctx: WorkerContext): Promise<number> {
  return purgeExpiredPayloads(ctx.db);
}

/** Maintenance job: emails once when a balance is below EUR 1, deduped until the next top-up
 * (see ledger.ts's creditTopup, which clears this dedupe key). */
export async function runLowBalanceCheckJob(ctx: WorkerContext): Promise<number> {
  const rows = await ctx.db
    .select()
    .from(creditAccounts)
    .where(lt(creditAccounts.balanceMicro, LOW_BALANCE_THRESHOLD_MICRO));

  let notified = 0;
  for (const row of rows) {
    const shouldSend = await tryRecordNotification(ctx.db, {
      userId: row.userId,
      kind: LOW_BALANCE_DEDUPE_KEY,
      dedupeKey: LOW_BALANCE_DEDUPE_KEY,
    });
    if (!shouldSend) continue;
    const user = await findUserById(ctx.db, row.userId);
    if (!user) continue;
    await ctx.mailer.send({
      to: user.email,
      subject: 'SmartRelay: your balance is low',
      text: 'Your SmartRelay balance is below EUR 1.00. Top up to keep deliveries flowing.',
    });
    notified++;
  }
  return notified;
}
