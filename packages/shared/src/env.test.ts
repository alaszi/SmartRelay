import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv, type EnvSource } from './env';

const validKey = randomBytes(32).toString('base64');

const devEnv: EnvSource = {
  APP_URL: 'http://localhost:3000',
  INBOUND_DOMAIN: 'inbound.localhost',
  DATABASE_URL: 'postgres://smartrelay:smartrelay@localhost:5432/smartrelay',
  REDIS_URL: 'redis://localhost:6379',
  SESSION_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: validKey,
  MAIL_FROM: 'SmartRelay <no-reply@smartrelay.ro>',
  SMTP_URL: 'smtp://localhost:1025',
};

const prodExtras: EnvSource = {
  STRIPE_SECRET_KEY: 'stripe-secret-placeholder',
  STRIPE_WEBHOOK_SECRET: 'stripe-webhook-placeholder',
  GOOGLE_CLIENT_ID: 'google-id-placeholder',
  GOOGLE_CLIENT_SECRET: 'google-secret-placeholder',
  INBOUND_EMAIL_SECRET: 'inbound-secret-placeholder',
};

function issuesFor(source: EnvSource): readonly string[] {
  try {
    loadEnv(source);
  } catch (error) {
    if (error instanceof EnvValidationError) return error.issues;
    throw error;
  }
  throw new Error('expected loadEnv to throw');
}

describe('loadEnv', () => {
  it('accepts a minimal development environment and applies defaults', () => {
    const env = loadEnv(devEnv);

    expect(env.NODE_ENV).toBe('development');
    expect(env.MAIL_PROVIDER).toBe('smtp');
    expect(env.INBOUND_EMAIL_PROVIDER).toBe('postmark');
    expect(env.WHATSAPP_ENABLED).toBe(false);
    expect(env.TRUST_CLOUDFLARE).toBe(false);
    expect(env.SENTRY_DSN).toBeUndefined();
  });

  it('reports every missing required variable in one error', () => {
    const issues = issuesFor({});

    for (const name of [
      'APP_URL',
      'INBOUND_DOMAIN',
      'DATABASE_URL',
      'REDIS_URL',
      'SESSION_SECRET',
      'ENCRYPTION_KEY',
      'MAIL_FROM',
      'SMTP_URL',
    ]) {
      expect(
        issues.some((line) => line.startsWith(`${name}:`)),
        name,
      ).toBe(true);
    }
  });

  it('treats empty strings as unset', () => {
    const issues = issuesFor({ ...devEnv, SESSION_SECRET: '' });
    expect(issues).toEqual([expect.stringContaining('SESSION_SECRET')]);
  });

  it('never leaks values in error messages', () => {
    const badSecret = 'super-secret-value-that-is-too-short';
    const badKey = 'not-a-valid-key-but-secret-looking';
    const issues = issuesFor({
      ...devEnv,
      SESSION_SECRET: badSecret.slice(0, 10),
      ENCRYPTION_KEY: badKey,
      DATABASE_URL: 'mysql://user:hunter2@db/x',
    });

    const text = issues.join('\n');
    expect(text).not.toContain(badSecret.slice(0, 10));
    expect(text).not.toContain(badKey);
    expect(text).not.toContain('hunter2');
    expect(issues.length).toBe(3);
  });

  describe('ENCRYPTION_KEY', () => {
    it('rejects keys that do not decode to exactly 32 bytes', () => {
      const shortKey = randomBytes(16).toString('base64');
      const longKey = randomBytes(48).toString('base64');

      expect(issuesFor({ ...devEnv, ENCRYPTION_KEY: shortKey })).toHaveLength(1);
      expect(issuesFor({ ...devEnv, ENCRYPTION_KEY: longKey })).toHaveLength(1);
    });
  });

  describe('URL protocols', () => {
    it('rejects a non-postgres DATABASE_URL and a non-redis REDIS_URL', () => {
      const issues = issuesFor({
        ...devEnv,
        DATABASE_URL: 'http://localhost/db',
        REDIS_URL: 'http://localhost:6379',
      });
      expect(issues.map((line) => line.split(':')[0]).sort()).toEqual([
        'DATABASE_URL',
        'REDIS_URL',
      ]);
    });

    it('accepts postgresql:// and rediss://', () => {
      const env = loadEnv({
        ...devEnv,
        DATABASE_URL: 'postgresql://u:p@db.internal:5432/app',
        REDIS_URL: 'rediss://cache.internal:6380',
      });
      expect(env.REDIS_URL).toBe('rediss://cache.internal:6380');
    });
  });

  describe('mail provider', () => {
    it('requires a Postmark token when MAIL_PROVIDER=postmark', () => {
      const { SMTP_URL: _omit, ...withoutSmtp } = devEnv;
      const issues = issuesFor({ ...withoutSmtp, MAIL_PROVIDER: 'postmark' });
      expect(issues).toEqual([expect.stringContaining('POSTMARK_SERVER_TOKEN')]);

      const env = loadEnv({
        ...withoutSmtp,
        MAIL_PROVIDER: 'postmark',
        POSTMARK_SERVER_TOKEN: 'postmark-token-placeholder',
      });
      expect(env.MAIL_PROVIDER).toBe('postmark');
    });

    it('requires SMTP_URL when MAIL_PROVIDER=smtp', () => {
      const { SMTP_URL: _omit, ...withoutSmtp } = devEnv;
      expect(issuesFor(withoutSmtp)).toEqual([expect.stringContaining('SMTP_URL')]);
    });
  });

  describe('production', () => {
    it('requires Stripe, Google and inbound email secrets', () => {
      const issues = issuesFor({ ...devEnv, NODE_ENV: 'production' });
      expect(issues.map((line) => line.split(':')[0]).sort()).toEqual([
        'GOOGLE_CLIENT_ID',
        'GOOGLE_CLIENT_SECRET',
        'INBOUND_EMAIL_SECRET',
        'STRIPE_SECRET_KEY',
        'STRIPE_WEBHOOK_SECRET',
      ]);
    });

    it('reports field errors and production requirements in a single pass', () => {
      const issues = issuesFor({ ...devEnv, NODE_ENV: 'production', SESSION_SECRET: 'short' });
      const names = issues.map((line) => line.split(':')[0]);
      expect(names).toContain('SESSION_SECRET');
      expect(names).toContain('STRIPE_SECRET_KEY');
    });

    it('accepts a complete production environment', () => {
      const env = loadEnv({ ...devEnv, ...prodExtras, NODE_ENV: 'production' });
      expect(env.NODE_ENV).toBe('production');
    });
  });

  describe('feature flags', () => {
    it('parses WHATSAPP_ENABLED and TRUST_CLOUDFLARE as booleans', () => {
      const env = loadEnv({ ...devEnv, WHATSAPP_ENABLED: 'true', TRUST_CLOUDFLARE: 'false' });
      expect(env.WHATSAPP_ENABLED).toBe(true);
      expect(env.TRUST_CLOUDFLARE).toBe(false);
    });

    it('rejects values that are not a boolean', () => {
      expect(issuesFor({ ...devEnv, WHATSAPP_ENABLED: 'maybe' })).toEqual([
        expect.stringContaining('WHATSAPP_ENABLED'),
      ]);
    });
  });
});
