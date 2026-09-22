import { runDeliverJob } from '@smartrelay/db';
import type { DeliverJobData } from '@smartrelay/shared';
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
  return async function processDeliver(job: Job<DeliverJobData>): Promise<void> {
    const outcome = await runDeliverJob(
      ctx.db,
      { keyring: ctx.keyring, modules: ctx.modules, http: ctx.http },
      { eventId: job.data.eventId, attemptNo: job.attemptsMade + 1 },
    );

    switch (outcome.kind) {
      case 'noop':
      case 'success':
        return;
      case 'terminal':
        throw new UnrecoverableError(outcome.message);
      case 'retry':
        throw new Error(outcome.message);
    }
  };
}
