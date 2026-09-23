import {
  createDb,
  findUserByEmail,
  getBalance,
  listEventsForUser,
  listRelaysForUser,
} from '@smartrelay/db';
import { formatMicroEur } from '@smartrelay/shared';

/**
 * `pnpm admin:user --email x` (MASTER_PLAN section 12): balance, relays, and the most recent
 * events, for support/debugging without an admin UI.
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
    throw new Error('Usage: admin:user --email <email>');
  }
  return { email };
}

const url = process.env['DATABASE_URL'];
if (!url) {
  process.stderr.write('DATABASE_URL is not set\n');
  process.exit(1);
}

let args: Args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

const { db, close } = createDb(url, { max: 1 });
try {
  const user = await findUserByEmail(db, args.email);
  if (!user) {
    process.stderr.write(`No user with email ${args.email}\n`);
    process.exit(1);
  }

  const balance = await getBalance(db, user.id);
  const relays = await listRelaysForUser(db, user.id);
  const { events } = await listEventsForUser(db, user.id, { limit: 10 });

  process.stdout.write(`User: ${user.email} (${user.id})\n`);
  process.stdout.write(
    `Email verified: ${user.emailVerifiedAt ? user.emailVerifiedAt.toISOString() : 'no'}\n`,
  );
  process.stdout.write(`Created: ${user.createdAt.toISOString()}\n`);
  process.stdout.write(`Balance: ${formatMicroEur(balance)} EUR\n\n`);

  process.stdout.write(`Relays (${relays.length}):\n`);
  if (relays.length === 0) {
    process.stdout.write('  (none)\n');
  }
  for (const relay of relays) {
    process.stdout.write(
      `  ${relay.id}  ${relay.type.padEnd(14)} ${relay.status.padEnd(8)} "${relay.name}"` +
        (relay.lastTriggeredAt ? `  last triggered ${relay.lastTriggeredAt.toISOString()}` : '') +
        '\n',
    );
  }

  process.stdout.write(`\nLast ${events.length} events:\n`);
  if (events.length === 0) {
    process.stdout.write('  (none)\n');
  }
  for (const event of events) {
    process.stdout.write(
      `  ${event.receivedAt.toISOString()}  ${event.status.padEnd(16)} ${event.relayName}` +
        `  cost=${formatMicroEur(event.costMicro)}EUR` +
        (event.errorCode ? `  error=${event.errorCode}` : '') +
        '\n',
    );
  }
} finally {
  await close();
}
