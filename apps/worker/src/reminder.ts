import { runReminderJob } from '@smartrelay/db';
import type { ReminderJobData } from '@smartrelay/shared';
import { UnrecoverableError, type Job } from 'bullmq';
import type { WorkerContext } from './context';

/**
 * BullMQ adapter around packages/db's queue-agnostic runReminderJob, mirroring
 * createDeliverProcessor (apps/worker/src/deliver.ts) exactly: translate the outcome into BullMQ's
 * retry vocabulary, nothing else. Module 4's Advanced "SMS reminder" (MASTER_PLAN section 6).
 */
export function createReminderProcessor(ctx: WorkerContext) {
  return async function processReminder(job: Job<ReminderJobData>): Promise<void> {
    const outcome = await runReminderJob(
      ctx.db,
      { keyring: ctx.keyring, http: ctx.http },
      job.data.reminderId,
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
