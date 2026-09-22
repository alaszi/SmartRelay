import {
  countDeliveryAttempts,
  createRelay,
  createUser,
  creditTopup,
  getBalance,
  getEventById,
  getRelayEmailAddress,
  runDeliverJob,
  type DeliverDeps,
  type UserRow,
} from '@smartrelay/db';
import { createSafeHttpClient, emailApiModule } from '@smartrelay/engine';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, resetDb, type TestApp } from '../../test/helpers';

/**
 * End-to-end test for Module 2 (MASTER_PLAN Phase 3 "Done when": ingest -> adapter mock -> ledger
 * charge at the correct price -> log entry). "Ingest" here is the inbound-email trigger
 * (POST /inbound/email/postmark), Module 2's own trigger — not the generic /i/:token pipeline.
 */

const mswServer = setupServer();
beforeAll(() => mswServer.listen({ onUnhandledRequest: 'error' }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

let testApp: TestApp;
let user: UserRow;
let deps: DeliverDeps;

beforeEach(async () => {
  testApp = buildTestApp({}, { email_api: emailApiModule });
  await resetDb(testApp.ctx.db);
  user = await createUser(testApp.ctx.db, {
    email: `email-e2e-${Math.random().toString(36).slice(2)}@example.com`,
    passwordHash: 'h',
  });
  await creditTopup(testApp.ctx.db, {
    userId: user.id,
    amountMicro: 1_000_000n,
    providerSessionId: `cs_${Math.random()}`,
  });
  deps = {
    keyring: testApp.ctx.keyring,
    modules: testApp.ctx.modules,
    http: createSafeHttpClient({ resolver: async () => [{ address: '93.184.216.34', family: 4 }] }),
  };
});
afterEach(async () => {
  await testApp.close();
});

describe('Module 2 (email -> API parser): full pipeline', () => {
  it('ingests an inbound email, parses it, POSTs to the target, charges relay_http, and logs a delivery attempt', async () => {
    let seenBody: string | undefined;
    mswServer.use(
      http.post('https://target.example/webhook', async ({ request }) => {
        seenBody = await request.text();
        return HttpResponse.json({ received: true }, { status: 200 });
      }),
    );

    const relay = await createRelay(testApp.ctx.db, testApp.ctx.keyring, {
      userId: user.id,
      name: 'Order emails',
      type: 'email_api',
      inboundDomain: testApp.ctx.env.INBOUND_DOMAIN,
      configPublic: {
        targetUrl: 'https://target.example/webhook',
        parsingRules: [{ name: 'orderId', type: 'jsonpath', expression: '$.fields.Order' }],
      },
    });
    const address = await getRelayEmailAddress(testApp.ctx.db, relay.id);
    const balanceBefore = await getBalance(testApp.ctx.db, user.id);

    const inboundResponse = await testApp.app.inject({
      method: 'POST',
      url: '/inbound/email/postmark',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        From: 'customer@example.com',
        To: address,
        Subject: 'New order #1042',
        MessageID: `msg-${Math.random()}`,
        Date: new Date().toISOString(),
        TextBody: 'Name: Ana\nOrder: 1042\nTotal: 49.90',
        Headers: [],
      }),
    });
    expect(inboundResponse.statusCode).toBe(200);
    const { eventId } = inboundResponse.json();
    expect((await getEventById(testApp.ctx.db, eventId))?.status).toBe('QUEUED');

    // Simulate the worker picking the job up.
    const outcome = await runDeliverJob(testApp.ctx.db, deps, { eventId, attemptNo: 1 });
    expect(outcome).toEqual({ kind: 'success' });

    // The target received the default output plus the jsonpath-derived field.
    const sent = JSON.parse(seenBody ?? '{}') as {
      meta: { from: string; subject: string };
      fields: Record<string, string>;
    };
    expect(sent.meta.from).toBe('customer@example.com');
    expect(sent.meta.subject).toBe('New order #1042');
    expect(sent.fields.Name).toBe('Ana');
    expect(sent.fields.orderId).toBe('1042');

    // Ledger charge at the correct price (relay_http = EUR 0.005).
    const event = await getEventById(testApp.ctx.db, eventId);
    expect(event?.status).toBe('SUCCESS');
    expect(event?.costMicro).toBe(5_000n);
    expect(event?.finalStatusCode).toBe(200);
    expect(await getBalance(testApp.ctx.db, user.id)).toBe(balanceBefore - 5_000n);

    // Log entry.
    expect(await countDeliveryAttempts(testApp.ctx.db, eventId)).toBe(1);
  });

  it('does not bill when the target destination is unreachable (retryable, not billed)', async () => {
    const relay = await createRelay(testApp.ctx.db, testApp.ctx.keyring, {
      userId: user.id,
      name: 'Order emails',
      type: 'email_api',
      inboundDomain: testApp.ctx.env.INBOUND_DOMAIN,
      configPublic: { targetUrl: 'https://target.example/down', parsingRules: [] },
    });
    const address = await getRelayEmailAddress(testApp.ctx.db, relay.id);
    mswServer.use(
      http.post('https://target.example/down', () => HttpResponse.json({}, { status: 503 })),
    );

    const inboundResponse = await testApp.app.inject({
      method: 'POST',
      url: '/inbound/email/postmark',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        From: 'customer@example.com',
        To: address,
        Subject: 'Order',
        MessageID: `msg-${Math.random()}`,
        Date: new Date().toISOString(),
        TextBody: 'Order: 1',
        Headers: [],
      }),
    });
    const { eventId } = inboundResponse.json();

    const outcome = await runDeliverJob(testApp.ctx.db, deps, { eventId, attemptNo: 1 });

    expect(outcome.kind).toBe('retry');
    const event = await getEventById(testApp.ctx.db, eventId);
    expect(event?.status).toBe('PROCESSING');
    expect(event?.costMicro).toBe(0n);
  });
});
