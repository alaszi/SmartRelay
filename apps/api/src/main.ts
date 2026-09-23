import { createDb } from '@smartrelay/db';
import {
  createProductionModuleRegistry,
  createSafeHttpClient,
  createSmtpMailer,
  createStripePaymentProvider,
  keyringFromEnv,
} from '@smartrelay/engine';
import { DELIVER_QUEUE_NAME, loadEnvOrExit } from '@smartrelay/shared';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { buildApp } from './app';

const env = loadEnvOrExit();
const { db } = createDb(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const keyring = keyringFromEnv(env);
const mailer = createSmtpMailer({
  url: env.SMTP_URL ?? 'smtp://localhost:1025',
  from: env.MAIL_FROM,
});
const deliverQueue = new Queue(DELIVER_QUEUE_NAME, { connection: redis });

const modules = createProductionModuleRegistry();
const http = createSafeHttpClient();
const google =
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
    : undefined;
const paymentProvider =
  env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET
    ? createStripePaymentProvider(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET)
    : undefined;
const app = buildApp({
  env,
  db,
  redis,
  keyring,
  mailer,
  deliverQueue,
  modules,
  http,
  ...(google ? { google } : {}),
  ...(paymentProvider ? { paymentProvider } : {}),
});

try {
  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
}
