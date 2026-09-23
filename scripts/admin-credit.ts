import { randomUUID } from 'node:crypto';
import { adjustBalance, createDb, findUserByEmail, getBalance } from '@smartrelay/db';
import { formatMicroEur, parseEurToMicro } from '@smartrelay/shared';

/**
 * `pnpm admin:credit --email x --amount 5.00 --reason "..."` (MASTER_PLAN section 12).
 * Refunds/chargebacks are manual in v1 (section 11): this is that manual path, a ledger
 * `adjustment`/`refund` row, never touching Stripe. A negative --amount deducts (e.g. a
 * chargeback); --kind refund vs. the default adjustment is just which LEDGER_KINDS value is
 * recorded, for reporting.
 */

interface Args {
  email: string;
  amountMicro: bigint;
  reason: string;
  kind: 'adjustment' | 'refund';
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
  const amount = flags.get('amount');
  const reason = flags.get('reason');
  const kind = flags.get('kind') ?? 'adjustment';
  if (!email || !amount || !reason) {
    throw new Error(
      'Usage: admin:credit --email <email> --amount <euros> --reason "<text>" [--kind adjustment|refund]',
    );
  }
  if (kind !== 'adjustment' && kind !== 'refund') {
    throw new Error('--kind must be "adjustment" or "refund"');
  }

  return { email, amountMicro: parseEurToMicro(amount), reason, kind };
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

  const { entry, duplicate } = await adjustBalance(db, {
    userId: user.id,
    deltaMicro: args.amountMicro,
    kind: args.kind,
    reason: args.reason,
    idempotencyKey: `admin:${randomUUID()}`,
  });
  if (duplicate) {
    // Practically unreachable: the idempotency key is freshly random every run.
    process.stderr.write('Idempotency key collision; nothing was applied\n');
    process.exit(1);
  }

  const balance = await getBalance(db, user.id);
  process.stdout.write(
    `${args.kind} of ${formatMicroEur(args.amountMicro)} EUR applied to ${args.email} ` +
      `(ledger entry ${entry.id}). New balance: ${formatMicroEur(balance)} EUR\n`,
  );
} finally {
  await close();
}
