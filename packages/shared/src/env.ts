import { z } from 'zod';

const BASE64_32_BYTES = /^[A-Za-z0-9+/]{43}=$/;

const optionalSecret = z.string().min(1).optional();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.url({ protocol: /^https?$/ }),
  INBOUND_DOMAIN: z.hostname(),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
  ENCRYPTION_KEY: z
    .string()
    .regex(BASE64_32_BYTES, 'must be 32 random bytes encoded as base64 (44 characters)'),

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
