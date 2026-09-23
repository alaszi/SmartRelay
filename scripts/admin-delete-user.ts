import { createDb, deleteUser, findUserByEmail, previewUserDeletion } from '@smartrelay/db';

/**
 * `pnpm admin:delete-user --email x` (MASTER_PLAN section 7 & 12): GDPR account deletion. Removes
 * all of a user's data except ledger rows required for accounting, which survive anonymized
 * (`credit_ledger`/`topups` foreign keys are `ON DELETE SET NULL`; everything else cascades — see
 * `deleteUser` in packages/db/src/users.ts for the full explanation).
 *
 * Irreversible, so it defaults to a dry run: it prints what would be removed and does nothing
 * unless `--yes` is also passed.
 */

interface Args {
  email: string;
  confirmed: boolean;
}

function parseArgs(argv: string[]): Args {
  const confirmed = argv.includes('--yes');
  const rest = argv.filter((a) => a !== '--yes');

  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`Malformed arguments near "${key ?? ''}"`);
    }
    flags.set(key.slice(2), value);
  }

  const email = flags.get('email');
  if (!email) {
    throw new Error('Usage: admin:delete-user --email <email> [--yes]');
  }
  return { email, confirmed };
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

  const summary = await previewUserDeletion(db, user.id);
  process.stdout.write(`About to delete user ${user.email} (${user.id}):\n`);
  process.stdout.write(`  ${summary.relayCount} relay(s) (and their events/payloads)\n`);
  process.stdout.write(`  ${summary.eventCount} event(s) total\n`);
  process.stdout.write(`  ${summary.oauthConnectionCount} OAuth connection(s)\n`);
  process.stdout.write(`  ${summary.sessionCount} active session(s)\n`);
  process.stdout.write(
    `Ledger and top-up rows are kept for accounting, anonymized (user_id set to null).\n`,
  );

  if (!args.confirmed) {
    process.stdout.write('\nDry run — nothing was deleted. Re-run with --yes to proceed.\n');
    process.exit(0);
  }

  await deleteUser(db, user.id);
  process.stdout.write(`\nDeleted user ${args.email}.\n`);
} finally {
  await close();
}
