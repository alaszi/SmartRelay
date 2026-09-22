import { z } from 'zod';

const BASE64_32_BYTES = /^[A-Za-z0-9+/]{43}=$/;

/** Key ids appear in stored blobs (`keyId:iv:tag:ciphertext`), so they must never contain ':'. */
export const ENCRYPTION_KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export interface PreviousEncryptionKey {
  id: string;
  /** 32 bytes, base64 encoded. */
  key: string;
}

/**
 * Parses ENCRYPTION_KEYS_PREVIOUS: comma separated `id:base64key` entries that stay valid for
 * decryption after a key rotation. Returns null when the value is malformed.
 */
export function parsePreviousEncryptionKeys(raw: string): PreviousEncryptionKey[] | null {
  const keys: PreviousEncryptionKey[] = [];
  for (const entry of raw.split(',')) {
    const separator = entry.indexOf(':');
    if (separator === -1) return null;
    const id = entry.slice(0, separator).trim();
    const key = entry.slice(separator + 1).trim();
    if (!ENCRYPTION_KEY_ID_PATTERN.test(id) || !BASE64_32_BYTES.test(key)) return null;
    keys.push({ id, key });
  }
  return keys;
}

const optionalSecret = z.string().min(1).optional();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.url({ protocol: /^https?$/ }),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  INBOUND_DOMAIN: z.hostname(),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
  ENCRYPTION_KEY: z
    .string()
    .regex(BASE64_32_BYTES, 'must be 32 random bytes encoded as base64 (44 characters)'),
  ENCRYPTION_KEY_ID: z
    .string()
    .regex(ENCRYPTION_KEY_ID_PATTERN, 'must be 1-32 characters of A-Z a-z 0-9 _ -')
    .default('k1'),
  ENCRYPTION_KEYS_PREVIOUS: z
    .string()
    .refine(
      (value) => parsePreviousEncryptionKeys(value) !== null,
      'must be comma separated "id:base64key" entries with 32-byte keys',
    )
    .optional(),

  STRIPE_SECRET_KEY: optionalSecret,
  STRIPE_WEBHOOK_SECRET: optionalSecret,
  GOOGLE_CLIENT_ID: optionalSecret,
  GOOGLE_CLIENT_SECRET: optionalSecret,

  MAIL_FROM: z.string().min(3),
  MAIL_PROVIDER: z.enum(['postmark', 'smtp']).default('smtp'),
  POSTMARK_SERVER_TOKEN: optionalSecret,
  SMTP_URL: z.url({ protocol: /^smtps?$/ }).optional(),

  INBOUND_EMAIL_PROVIDER: z.enum(['postmark']).default('postmark'),
  INBOUND_EMAIL_SECRET: optionalSecret,

  WHATSAPP_ENABLED: z.stringbool().default(false),
  SENTRY_DSN: z.url().optional(),
  TRUST_CLOUDFLARE: z.stringbool().default(false),
});

export type Env = z.infer<typeof envSchema>;

export type EnvSource = Record<string, string | undefined>;

export class EnvValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid environment configuration:\n${issues.map((line) => `  - ${line}`).join('\n')}`);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

const PRODUCTION_REQUIRED = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'INBOUND_EMAIL_SECRET',
] as const;

// Runs on the raw values, independent of the field schema, so that one pass reports every problem
// instead of hiding these rules until all field errors are fixed.
function crossFieldIssues(source: EnvSource): string[] {
  const issues: string[] = [];
  const need = (name: string, reason: string) => {
    if (source[name] === undefined) issues.push(`${name}: required ${reason}`);
  };

  const mailProvider = source['MAIL_PROVIDER'] ?? 'smtp';
  if (mailProvider === 'postmark') need('POSTMARK_SERVER_TOKEN', 'when MAIL_PROVIDER=postmark');
  if (mailProvider === 'smtp') need('SMTP_URL', 'when MAIL_PROVIDER=smtp');

  if (source['NODE_ENV'] === 'production') {
    for (const name of PRODUCTION_REQUIRED) need(name, 'in production');
  }

  const previousRaw = source['ENCRYPTION_KEYS_PREVIOUS'];
  const previous = previousRaw === undefined ? null : parsePreviousEncryptionKeys(previousRaw);
  if (previous) {
    const ids = [source['ENCRYPTION_KEY_ID'] ?? 'k1', ...previous.map((entry) => entry.id)];
    if (new Set(ids).size !== ids.length) {
      issues.push(
        'ENCRYPTION_KEYS_PREVIOUS: key ids must be unique and differ from ENCRYPTION_KEY_ID',
      );
    }
  }
  return issues;
}

/**
 * Parses and validates the environment. Empty strings count as unset, so a bare `KEY=` line in a
 * .env file behaves like a missing variable. Error messages name variables and rules only and
 * never include the offending value, because values may be secrets.
 */
export function loadEnv(source: EnvSource = process.env): Env {
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ''),
  );

  const result = envSchema.safeParse(cleaned);
  const issues = [
    ...(result.success
      ? []
      : result.error.issues.map(
          (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
        )),
    ...crossFieldIssues(cleaned),
  ];

  if (!result.success || issues.length > 0) throw new EnvValidationError(issues);
  return result.data;
}

/** Startup helper: prints the validation problems and exits with code 1 instead of booting. */
export function loadEnvOrExit(source: EnvSource = process.env): Env {
  try {
    return loadEnv(source);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}
