import { releaseHeldEvents } from '@smartrelay/db';
import { DELIVER_MAX_ATTEMPTS } from '@smartrelay/shared';
import type { WorkerContext } from './context';

/**
 * Runs after a top-up credits a user (MASTER_PLAN section 7: "On successful top-up, release held
 * events oldest-first into the deliver queue"). The eventual Stripe webhook handler (Phase 5)
 * calls this after crediting the top-up; exercised directly here since Phase 5 does not exist yet.
 * packages/db's releaseHeldEvents does the queue-agnostic half (flips events to QUEUED, clears the
 * low-balance notification dedupe key); enqueuing onto BullMQ is this app's job.
 * Returns how many events were released.
 */
export async function releaseHeldEventsForUser(
  ctx: WorkerContext,
  userId: string,
): Promise<number> {
  const released = await releaseHeldEvents(ctx.db, userId);

  for (const event of released) {
    await ctx.deliverQueue.add(
      'deliver',
      { eventId: event.id },
      { jobId: event.id, attempts: DELIVER_MAX_ATTEMPTS, backoff: { type: 'custom' } },
    );
  }

  return released.length;
}
