import { createDb, getEventById, listPendingReminders } from '@smartrelay/db';
import {
  createProductionModuleRegistry,
  createSafeHttpClient,
  createSmtpMailer,
  keyringFromEnv,
} from '@smartrelay/engine';
import {
  DELIVER_MAX_ATTEMPTS,
  DELIVER_QUEUE_NAME,
  deliverBackoffMs,
  loadEnvOrExit,
  REMINDER_QUEUE_NAME,
} from '@smartrelay/shared';
import { Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';
import Redis from 'ioredis';
import { createDeliverProcessor } from './deliver';
import { runHeldExpiryJob, runLowBalanceCheckJob, runRetentionPurgeJob } from './maintenance';
import { createReminderProcessor } from './reminder';
import type { WorkerContext } from './context';

const env = loadEnvOrExit();
const { db } = createDb(env.DATABASE_URL);
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const keyring = keyringFromEnv(env);
const mailer = createSmtpMailer({
  url: env.SMTP_URL ?? 'smtp://localhost:1025',
  from: env.MAIL_FROM,
});
const deliverQueue = new Queue(DELIVER_QUEUE_NAME, { connection });
const reminderQueue = new Queue(REMINDER_QUEUE_NAME, { connection });
const http = createSafeHttpClient();

const ctx: WorkerContext = {
  env,
  db,
  redis: connection,
  keyring,
  mailer,
  deliverQueue,
  reminderQueue,
  modules: createProductionModuleRegistry(),
  http,
};

const worker = new Worker(DELIVER_QUEUE_NAME, createDeliverProcessor(ctx), {
  connection,
  settings: { backoffStrategy: (attemptsMade) => deliverBackoffMs(attemptsMade) ?? 0 },
});
const reminderWorker = new Worker(REMINDER_QUEUE_NAME, createReminderProcessor(ctx), {
  connection,
  settings: { backoffStrategy: (attemptsMade) => deliverBackoffMs(attemptsMade) ?? 0 },
});

worker.on('failed', (job, error) => {
  process.stderr.write(`deliver job ${job?.id ?? '?'} failed: ${error.message}\n`);
});
reminderWorker.on('failed', (job, error) => {
  process.stderr.write(`reminder job ${job?.id ?? '?'} failed: ${error.message}\n`);
});

// Durability (MASTER_PLAN section 13): Redis is rebuildable, the DB is the source of truth. A job
// already in the queue with this jobId is left alone by BullMQ; this only recovers events a crash
// left stuck with no live job.
async function reenqueueStuckEvents(): Promise<void> {
  const stuck = await db.execute<{ id: string }>(
    sql`SELECT id FROM events WHERE status IN ('QUEUED', 'PROCESSING')`,
  );
  for (const row of stuck.rows) {
    const event = await getEventById(db, row.id);
    if (!event) continue;
    await deliverQueue.add(
      'deliver',
      { eventId: event.id },
      { jobId: event.id, attempts: DELIVER_MAX_ATTEMPTS, backoff: { type: 'custom' } },
    );
  }
}
await reenqueueStuckEvents();

// Durability (MASTER_PLAN section 6: "on worker start, re-enqueue pending reminders from the DB").
// Same idempotent-by-jobId reasoning as reenqueueStuckEvents: a reminder already scheduled in
// Redis is left alone, this only recovers ones a Redis loss would otherwise drop silently. A past
// runAt just means the job fires immediately (delay clamped to 0), same as a fresh schedule would.
async function reenqueuePendingReminders(): Promise<void> {
  const pending = await listPendingReminders(db);
  for (const reminder of pending) {
    await reminderQueue.add(
      'reminder',
      { reminderId: reminder.id },
      {
        jobId: reminder.id,
        delay: Math.max(0, reminder.runAt.getTime() - Date.now()),
        attempts: DELIVER_MAX_ATTEMPTS,
        backoff: { type: 'custom' },
      },
    );
  }
}
await reenqueuePendingReminders();

const timers = [
  setInterval(() => void runHeldExpiryJob(ctx), 5 * 60 * 1000),
  setInterval(() => void runRetentionPurgeJob(ctx), 24 * 60 * 60 * 1000),
  setInterval(() => void runLowBalanceCheckJob(ctx), 15 * 60 * 1000),
];

process.stdout.write(
  `worker: listening on queues "${DELIVER_QUEUE_NAME}", "${REMINDER_QUEUE_NAME}" (${env.NODE_ENV})\n`,
);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    for (const timer of timers) clearInterval(timer);
    void Promise.all([worker.close(), reminderWorker.close()]).then(() => process.exit(0));
  });
}
