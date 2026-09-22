import {
  countDeliveryAttempts,
  createRelay,
  createUser,
  creditTopup,
  getBalance,
  getEventById,
  runDeliverJob,
  type DeliverDeps,
  type UserRow,
} from '@smartrelay/db';
import { createSafeHttpClient, webhookSmsModule } from '@smartrelay/engine';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, resetDb, type TestApp } from '../../test/helpers';

/**
 * End-to-end test for Module 1 (MASTER_PLAN Phase 3 "Done when": each module has a passing
 * end-to-end test — ingest -> adapter mock -> ledger charge at the correct price -> log entry).
 * The provider call is mocked with msw (a real Twilio-shaped HTTP response), not the test-only
 * echo module used elsewhere; everything else is the real ingest route and the real
 * runDeliverJob/chargeEvent pipeline.
 */

const mswServer = setupServer();
beforeAll(() => mswServer.listen({ onUnhandledRequest: 'error' }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

let testApp: TestApp;
let user: UserRow;
let deps: DeliverDeps;

beforeEach(async () => {
  testApp = buildTestApp({}, { webhook_sms: webhookSmsModule });
  await resetDb(testApp.ctx.db);
  user = await createUser(testApp.ctx.db, {
    email: `sms-e2e-${Math.random().toString(36).slice(2)}@example.com`,
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
    // msw intercepts before any socket opens; the resolver just needs a non-blocked-looking address.
    http: createSafeHttpClient({ resolver: async () => [{ address: '93.184.216.34', family: 4 }] }),
  };
});
afterEach(async () => {
  await testApp.close();
});

describe('Module 1 (webhook -> SMS via Twilio): full pipeline', () => {
  it('ingests a webhook, sends the SMS, charges sms_dispatch, and logs a delivery attempt', async () => {
    let seenBody: string | undefined;
    let seenAuth: string | null = null;
    mswServer.use(
      http.post(
        'https://api.twilio.com/2010-04-01/Accounts/AC_TEST/Messages.json',
        async ({ request }) => {
          seenAuth = request.headers.get('authorization');
          seenBody = await request.text();
          return HttpResponse.json({ sid: 'SM_TEST_1' }, { status: 201 });
        },
      ),
    );

    const relay = await createRelay(testApp.ctx.db, testApp.ctx.keyring, {
      userId: user.id,
      name: 'Order shipped SMS',
      type: 'webhook_sms',
      configPublic: {
        provider: 'twilio',
        from: '+15551234567',
        recipientPath: '$.customer.phone',
        template: 'Hi {{$.customer.name}}, order #{{$.order.id}} shipped!',
      },
      configSecret: { accountSid: 'AC_TEST', authToken: 'secret-auth-token' },
    });
    const balanceBefore = await getBalance(testApp.ctx.db, user.id);

    const ingestResponse = await testApp.app.inject({
      method: 'POST',
      url: `/i/${relay.ingestToken}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        customer: { name: 'Ana', phone: '0722 123 456' },
        order: { id: 1042 },
      }),
    });
    expect(ingestResponse.statusCode).toBe(202);
    const { eventId } = ingestResponse.json();
    expect((await getEventById(testApp.ctx.db, eventId))?.status).toBe('QUEUED');

    // Simulate the worker picking the job up (see packages/db/src/deliver.int.test.ts for the
    // exhaustive runDeliverJob matrix; this test is only about the module wired end to end).
    const outcome = await runDeliverJob(testApp.ctx.db, deps, { eventId, attemptNo: 1 });
    expect(outcome).toEqual({ kind: 'success' });

    // Twilio call: correct auth, correct E.164 recipient, correctly rendered body.
    expect(seenAuth).toBe(`Basic ${Buffer.from('AC_TEST:secret-auth-token').toString('base64')}`);
    const params = new URLSearchParams(seenBody);
    expect(params.get('To')).toBe('+40722123456');
    expect(params.get('Body')).toBe('Hi Ana, order #1042 shipped!');

    // Ledger charge at the correct price (sms_dispatch = EUR 0.025).
    const event = await getEventById(testApp.ctx.db, eventId);
    expect(event?.status).toBe('SUCCESS');
    expect(event?.costMicro).toBe(25_000n);
    expect(event?.finalStatusCode).toBe(201);
    expect(await getBalance(testApp.ctx.db, user.id)).toBe(balanceBefore - 25_000n);

    // Log entry: one delivery_attempts row recording the send.
    expect(await countDeliveryAttempts(testApp.ctx.db, eventId)).toBe(1);

    // The account's Twilio auth token is never in the encrypted-blob plaintext exposure surface.
    expect(
      JSON.stringify(event, (_key, value: unknown) =>
        typeof value === 'bigint' ? String(value) : value,
      ),
    ).not.toContain('secret-auth-token');
  });

  it('does not bill when Twilio rejects the number (terminal, no retry)', async () => {
    mswServer.use(
      http.post('https://api.twilio.com/2010-04-01/Accounts/AC_TEST/Messages.json', () =>
        HttpResponse.json(
          { code: 21211, message: "The 'To' number is not a valid phone number." },
          { status: 400 },
        ),
      ),
    );

    const relay = await createRelay(testApp.ctx.db, testApp.ctx.keyring, {
      userId: user.id,
      name: 'Order shipped SMS',
      type: 'webhook_sms',
      configPublic: {
        provider: 'twilio',
        from: '+15551234567',
        recipientPath: '$.customer.phone',
        template: 'Hi {{$.customer.name}}',
      },
      configSecret: { accountSid: 'AC_TEST', authToken: 'secret-auth-token' },
    });
    const balanceBefore = await getBalance(testApp.ctx.db, user.id);

    const ingestResponse = await testApp.app.inject({
      method: 'POST',
      url: `/i/${relay.ingestToken}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ customer: { name: 'Ana', phone: '0722123456' } }),
    });
    const { eventId } = ingestResponse.json();

    const outcome = await runDeliverJob(testApp.ctx.db, deps, { eventId, attemptNo: 1 });

    expect(outcome).toMatchObject({ kind: 'terminal', errorCode: 'TWILIO_21211' });
    const event = await getEventById(testApp.ctx.db, eventId);
    expect(event?.status).toBe('FAILED');
    expect(event?.costMicro).toBe(0n);
    expect(await getBalance(testApp.ctx.db, user.id)).toBe(balanceBefore);
    expect(await countDeliveryAttempts(testApp.ctx.db, eventId)).toBe(1);
  });
});
