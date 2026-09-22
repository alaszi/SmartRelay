import { consumeEmailVerifyToken } from '@smartrelay/db';
import { hashToken } from '@smartrelay/engine';
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
// dev), so ctx.stripe is undefined here — exactly the "not configured" deployment state.

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
});
