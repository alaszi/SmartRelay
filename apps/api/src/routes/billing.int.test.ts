import {
  consumeEmailVerifyToken,
  createTopup,
  getBalance,
  setTopupProviderSession,
} from '@smartrelay/db';
import { createStripePaymentProvider, hashToken } from '@smartrelay/engine';
import { signStripeWebhookForTest } from '@smartrelay/engine/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, resetDb, TEST_APP_URL, type TestApp } from '../../test/helpers';

let testApp: TestApp;
let cookie: string;

beforeEach(async () => {
  testApp = buildTestApp();
  await resetDb(testApp.ctx.db);

  const response = await testApp.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { origin: TEST_APP_URL },
    payload: { email: 'billing@example.com', password: 'hunter22' },
  });
  cookie = `sr_session=${response.cookies.find((c) => c.name === 'sr_session')!.value}`;
  const link = testApp.mailer.sent.at(-1)?.text ?? '';
  const token = new URL(link.split(': ')[1] ?? '', TEST_APP_URL).searchParams.get('token')!;
  await consumeEmailVerifyToken(testApp.ctx.db, hashToken(token));
});
afterEach(async () => {
  await testApp.close();
});

// The test app never configures STRIPE_SECRET_KEY (packages/shared's Env treats it as optional in
// dev), so ctx.paymentProvider is undefined here — exactly the "not configured" deployment state.

describe('POST /api/billing/checkout', () => {
  it('503s when Stripe is not configured', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      headers: { cookie, origin: TEST_APP_URL },
      payload: { amountEur: 10 },
    });
    expect(response.statusCode).toBe(503);
  });

  it('rejects an amount below the €5 minimum', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      headers: { cookie, origin: TEST_APP_URL },
      payload: { amountEur: 1 },
    });
    expect(response.statusCode).toBe(400);
  });

  it('requires authentication', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/billing/checkout',
      headers: { origin: TEST_APP_URL },
      payload: { amountEur: 10 },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('GET /api/billing/history', () => {
  it('returns the balance and an empty top-up list for a fresh account', async () => {
    const response = await testApp.app.inject({
      method: 'GET',
      url: '/api/billing/history',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ balance: '0.00', topups: [] });
  });
});

describe('POST /api/webhooks/stripe', () => {
  it('503s when Stripe is not configured', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=fake' },
      payload: JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' }),
    });
    expect(response.statusCode).toBe(503);
  });

  // Everything below configures a real PaymentProvider (a genuine local HMAC signature, verified
  // by the unmocked webhook handler — see packages/engine/src/testing.ts's
  // signStripeWebhookForTest) so these exercise the actual signature-verification code path, not a
  // stand-in for it. Each test gets its own app instance since the outer one has no provider.
  const WEBHOOK_SECRET = 'whsec_test_secret';

  async function buildBillingApp(): Promise<TestApp> {
    const paymentProvider = createStripePaymentProvider('sk_test_unused', WEBHOOK_SECRET);
    const app = buildTestApp({}, undefined, { paymentProvider });
    await resetDb(app.ctx.db);
    return app;
  }

  it('credits the ledger exactly once even when the event is replayed (Phase 5 "done when": a stripe listen replay credits once)', async () => {
    const billingApp = await buildBillingApp();
    try {
      const register = await billingApp.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers: { origin: TEST_APP_URL },
        payload: { email: 'stripe-replay@example.com', password: 'hunter22' },
      });
      const userId = (register.json() as { id: string }).id;

      const topup = await createTopup(billingApp.ctx.db, {
        userId,
        provider: 'stripe',
        amountCents: 1000,
      });
      await setTopupProviderSession(billingApp.ctx.db, topup.id, 'cs_test_123');

      const payload = JSON.stringify({
        id: 'evt_test_1',
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_test_123' } },
      });
      const signature = signStripeWebhookForTest({ payload, secret: WEBHOOK_SECRET });
      const balanceBefore = await getBalance(billingApp.ctx.db, userId);

      const first = await billingApp.app.inject({
        method: 'POST',
        url: '/api/webhooks/stripe',
        headers: { 'content-type': 'application/json', 'stripe-signature': signature },
        payload,
      });
      expect(first.statusCode).toBe(200);
      const balanceAfterFirst = await getBalance(billingApp.ctx.db, userId);
      expect(balanceAfterFirst).toBe(balanceBefore + 10_000_000n); // amountCents 1000 = €10.00

      // The replay: the identical event id and signature, exactly what `stripe listen`'s retry or
      // a real Stripe redelivery sends.
      const second = await billingApp.app.inject({
        method: 'POST',
        url: '/api/webhooks/stripe',
        headers: { 'content-type': 'application/json', 'stripe-signature': signature },
        payload,
      });
      expect(second.statusCode).toBe(200);
      expect(await getBalance(billingApp.ctx.db, userId)).toBe(balanceAfterFirst);
    } finally {
      await billingApp.close();
    }
  });

  it('rejects a payload with an invalid signature', async () => {
    const billingApp = await buildBillingApp();
    try {
      const response = await billingApp.app.inject({
        method: 'POST',
        url: '/api/webhooks/stripe',
        headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=forged' },
        payload: JSON.stringify({ id: 'evt_x', type: 'checkout.session.completed' }),
      });
      expect(response.statusCode).toBe(400);
    } finally {
      await billingApp.close();
    }
  });

  it('ignores unrelated event types without crediting anything', async () => {
    const billingApp = await buildBillingApp();
    try {
      const payload = JSON.stringify({ id: 'evt_unrelated', type: 'payment_intent.succeeded' });
      const signature = signStripeWebhookForTest({ payload, secret: WEBHOOK_SECRET });

      const response = await billingApp.app.inject({
        method: 'POST',
        url: '/api/webhooks/stripe',
        headers: { 'content-type': 'application/json', 'stripe-signature': signature },
        payload,
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await billingApp.close();
    }
  });
});
