import { runDeliverJob } from '@smartrelay/db';
import { DELIVER_MAX_ATTEMPTS, type DeliverJobData } from '@smartrelay/shared';
import { UnrecoverableError, type Job } from 'bullmq';
import type { WorkerContext } from './context';

/**
 * BullMQ adapter around packages/db's queue-agnostic runDeliverJob: the only job of this module is
 * translating its outcome into BullMQ's retry vocabulary (throw UnrecoverableError to stop retries
 * immediately regardless of attempts remaining; throw a plain Error to let BullMQ retry with the
 * queue's custom backoff). All the actual delivery logic lives in packages/db, not here, so it can
 * be reused (e.g. by tests) without pulling in BullMQ or coupling to this app.
 */
export function createDeliverProcessor(ctx: WorkerContext) {
  const google =
    ctx.env.GOOGLE_CLIENT_ID && ctx.env.GOOGLE_CLIENT_SECRET
      ? { clientId: ctx.env.GOOGLE_CLIENT_ID, clientSecret: ctx.env.GOOGLE_CLIENT_SECRET }
      : undefined;

  return async function processDeliver(job: Job<DeliverJobData>): Promise<void> {
    const outcome = await runDeliverJob(
      ctx.db,
      { keyring: ctx.keyring, modules: ctx.modules, http: ctx.http, ...(google ? { google } : {}) },
      { eventId: job.data.eventId, attemptNo: job.attemptsMade + 1 },
    );

    switch (outcome.kind) {
      case 'noop':
        return;
      case 'success':
        if (outcome.scheduledReminder) {
          const { reminderId, runAt } = outcome.scheduledReminder;
          await ctx.reminderQueue.add(
            'reminder',
            { reminderId },
            {
              jobId: reminderId,
              delay: Math.max(0, runAt.getTime() - Date.now()),
              attempts: DELIVER_MAX_ATTEMPTS,
              backoff: { type: 'custom' },
            },
          );
        }
        return;
      case 'terminal':
        throw new UnrecoverableError(outcome.message);
      case 'retry':
        throw new Error(outcome.message);
    }
  };
}
