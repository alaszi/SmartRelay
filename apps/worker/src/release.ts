import { clearNotification, listHeldEventsForUser, markQueued } from '@smartrelay/db';
import { DELIVER_MAX_ATTEMPTS } from '@smartrelay/shared';
import type { WorkerContext } from './context';

/**
 * Runs after a top-up credits a user (MASTER_PLAN section 7: "On successful top-up, release held
 * events oldest-first into the deliver queue"). The eventual Stripe webhook handler (Phase 5)
 * calls this after crediting the top-up; exercised directly here since Phase 5 does not exist yet.
 * Also clears the low-balance notification dedupe key, so a fresh dip below EUR 1 after this
 * top-up can notify again ("deduped per top-up cycle", section 7).
 * Returns how many events were released.
 */
export async function releaseHeldEventsForUser(
  ctx: WorkerContext,
  userId: string,
): Promise<number> {
  await clearNotification(ctx.db, { userId, dedupeKey: 'low-balance' });

  const held = await listHeldEventsForUser(ctx.db, userId);

  for (const event of held) {
    await markQueued(ctx.db, event.id);
    await ctx.deliverQueue.add(
      'deliver',
      { eventId: event.id },
      { jobId: event.id, attempts: DELIVER_MAX_ATTEMPTS, backoff: { type: 'custom' } },
    );
  }

  return held.length;
}
