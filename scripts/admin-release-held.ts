import { createDb, findUserByEmail, releaseHeldEvents } from '@smartrelay/db';
import { DELIVER_MAX_ATTEMPTS, DELIVER_QUEUE_NAME } from '@smartrelay/shared';
import { Queue } from 'bullmq';
import Redis from 'ioredis';

/**
 * `pnpm admin:release-held --email x` (MASTER_PLAN section 12): manually releases a user's
 * `HELD_NO_CREDIT` events into the deliver queue, the same effect a successful top-up has
 * (`releaseHeldEvents` in packages/db does the queue-agnostic half; enqueuing onto BullMQ here
 * mirrors apps/api/src/routes/billing.ts's `creditCheckoutSession` and
 * apps/worker/src/release.ts's `releaseHeldEventsForUser`). Useful when support manually credits a
 * user outside Stripe (e.g. after `admin:credit`) and the held events should go out immediately
 * rather than waiting for the next top-up.
 */

interface Args {
  email: string;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`Malformed arguments near "${key ?? ''}"`);
    }
    flags.set(key.slice(2), value);
  }

  const email = flags.get('email');
  if (!email) {
    throw new Error('Usage: admin:release-held --email <email>');
  }
  return { email };
}

const databaseUrl = process.env['DATABASE_URL'];
const redisUrl = process.env['REDIS_URL'];
if (!databaseUrl) {
  process.stderr.write('DATABASE_URL is not set\n');
  process.exit(1);
}
if (!redisUrl) {
  process.stderr.write('REDIS_URL is not set\n');
  process.exit(1);
}

let args: Args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

const { db, close } = createDb(databaseUrl, { max: 1 });
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const deliverQueue = new Queue(DELIVER_QUEUE_NAME, { connection });

try {
  const user = await findUserByEmail(db, args.email);
  if (!user) {
    process.stderr.write(`No user with email ${args.email}\n`);
    process.exit(1);
  }

  const released = await releaseHeldEvents(db, user.id);
  for (const event of released) {
    await deliverQueue.add(
      'deliver',
      { eventId: event.id },
      { jobId: event.id, attempts: DELIVER_MAX_ATTEMPTS, backoff: { type: 'custom' } },
    );
  }

  process.stdout.write(`Released ${released.length} held event(s) for ${args.email}\n`);
  for (const event of released) {
    process.stdout.write(`  ${event.id}  received ${event.receivedAt.toISOString()}\n`);
  }
} finally {
  await deliverQueue.close();
  connection.disconnect();
  await close();
}
