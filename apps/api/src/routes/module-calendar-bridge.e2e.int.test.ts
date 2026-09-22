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
import { calendarBridgeModule, createSafeHttpClient } from '@smartrelay/engine';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, resetDb, type TestApp } from '../../test/helpers';

/**
 * End-to-end test for Module 4 (MASTER_PLAN Phase 3 "Done when": ingest -> adapter mock -> ledger
 * charge at the correct price -> log entry). The OAuth web-connect flow
 * (GET /api/oauth/google/start|/callback) and the SMS reminder scheduling (a separate BullMQ queue
 * plus worker-startup re-enqueue) are Advanced/UI-adjacent pieces deferred to Phase 4, mirroring
 * Module 3's deferred automatic setWebhook registration; this covers the adapter itself.
 */

const mswServer = setupServer();
beforeAll(() => mswServer.listen({ onUnhandledRequest: 'error' }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

let testApp: TestApp;
let user: UserRow;
let deps: DeliverDeps;

beforeEach(async () => {
  testApp = buildTestApp({}, { calendar_bridge: calendarBridgeModule });
  await resetDb(testApp.ctx.db);
  user = await createUser(testApp.ctx.db, {
    email: `cal-e2e-${Math.random().toString(36).slice(2)}@example.com`,
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
    google: { clientId: 'client-1', clientSecret: 'secret-1' },
  };
});
afterEach(async () => {
  await testApp.close();
});

describe('Module 4 (calendar_bridge -> Google Calendar): full pipeline', () => {
  it('ingests a booking, creates the Calendar event, charges calendar_event, and logs a delivery attempt', async () => {
    let seenBody: { summary?: string; start?: { dateTime?: string } } | undefined;
    mswServer.use(
      http.post('https://oauth2.googleapis.com/token', () =>
        HttpResponse.json({ access_token: 'tok_123' }),
      ),
      http.post(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        async ({ request }) => {
          seenBody = (await request.json()) as typeof seenBody;
          return HttpResponse.json({ id: 'evt_google_1' });
        },
      ),
    );

    const relay = await createRelay(testApp.ctx.db, testApp.ctx.keyring, {
      userId: user.id,
      name: 'Bookings calendar',
      type: 'calendar_bridge',
      configPublic: {
        titleTemplate: 'Booking: {{$.customer.name}}',
        startPath: '$.booking.start',
        endPath: '$.booking.end',
      },
      configSecret: { refreshToken: 'refresh-1' },
    });
    const balanceBefore = await getBalance(testApp.ctx.db, user.id);

    const ingestResponse = await testApp.app.inject({
      method: 'POST',
      url: `/i/${relay.ingestToken}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        customer: { name: 'Ana' },
        booking: { start: '2026-03-01T10:00:00+02:00', end: '2026-03-01T11:00:00+02:00' },
      }),
    });
    expect(ingestResponse.statusCode).toBe(202);
    const { eventId } = ingestResponse.json();
    expect((await getEventById(testApp.ctx.db, eventId))?.status).toBe('QUEUED');

    const outcome = await runDeliverJob(testApp.ctx.db, deps, { eventId, attemptNo: 1 });
    expect(outcome).toEqual({ kind: 'success' });

    expect(seenBody?.summary).toBe('Booking: Ana');
    expect(seenBody?.start?.dateTime).toBe('2026-03-01T10:00:00.000+02:00');

    const event = await getEventById(testApp.ctx.db, eventId);
    expect(event?.status).toBe('SUCCESS');
    expect(event?.costMicro).toBe(10_000n); // calendar_event = EUR 0.01
    expect(await getBalance(testApp.ctx.db, user.id)).toBe(balanceBefore - 10_000n);
    expect(await countDeliveryAttempts(testApp.ctx.db, eventId)).toBe(1);

    // The refresh token is never in the encrypted-blob plaintext exposure surface.
    expect(
      JSON.stringify(event, (_key, value: unknown) =>
        typeof value === 'bigint' ? String(value) : value,
      ),
    ).not.toContain('refresh-1');
  });

  it('does not bill when end <= start (terminal INVALID_TIME_RANGE, no Google call)', async () => {
    mswServer.use(http.all('*', () => new Response('should not be called', { status: 500 })));

    const relay = await createRelay(testApp.ctx.db, testApp.ctx.keyring, {
      userId: user.id,
      name: 'Bookings calendar',
      type: 'calendar_bridge',
      configPublic: {
        titleTemplate: 'Booking: {{$.customer.name}}',
        startPath: '$.booking.start',
        endPath: '$.booking.end',
      },
      configSecret: { refreshToken: 'refresh-1' },
    });
    const balanceBefore = await getBalance(testApp.ctx.db, user.id);

    const ingestResponse = await testApp.app.inject({
      method: 'POST',
      url: `/i/${relay.ingestToken}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        customer: { name: 'Ana' },
        booking: { start: '2026-03-01T11:00:00+02:00', end: '2026-03-01T10:00:00+02:00' },
      }),
    });
    const { eventId } = ingestResponse.json();

    const outcome = await runDeliverJob(testApp.ctx.db, deps, { eventId, attemptNo: 1 });

    expect(outcome).toMatchObject({ kind: 'terminal', errorCode: 'INVALID_TIME_RANGE' });
    const event = await getEventById(testApp.ctx.db, eventId);
    expect(event?.status).toBe('FAILED');
    expect(event?.costMicro).toBe(0n);
    expect(await getBalance(testApp.ctx.db, user.id)).toBe(balanceBefore);
  });

  it('does not bill on a revoked Google connection (terminal GOOGLE_AUTH_REVOKED)', async () => {
    mswServer.use(
      http.post('https://oauth2.googleapis.com/token', () =>
        HttpResponse.json({ error: 'invalid_grant' }, { status: 400 }),
      ),
    );

    const relay = await createRelay(testApp.ctx.db, testApp.ctx.keyring, {
      userId: user.id,
      name: 'Bookings calendar',
      type: 'calendar_bridge',
      configPublic: {
        titleTemplate: 'Booking: {{$.customer.name}}',
        startPath: '$.booking.start',
        endPath: '$.booking.end',
      },
      configSecret: { refreshToken: 'refresh-1' },
    });
    const balanceBefore = await getBalance(testApp.ctx.db, user.id);

    const ingestResponse = await testApp.app.inject({
      method: 'POST',
      url: `/i/${relay.ingestToken}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        customer: { name: 'Ana' },
        booking: { start: '2026-03-01T10:00:00+02:00', end: '2026-03-01T11:00:00+02:00' },
      }),
    });
    const { eventId } = ingestResponse.json();

    const outcome = await runDeliverJob(testApp.ctx.db, deps, { eventId, attemptNo: 1 });

    expect(outcome).toMatchObject({ kind: 'terminal', errorCode: 'GOOGLE_AUTH_REVOKED' });
    const event = await getEventById(testApp.ctx.db, eventId);
    expect(event?.status).toBe('FAILED');
    expect(event?.costMicro).toBe(0n);
    expect(await getBalance(testApp.ctx.db, user.id)).toBe(balanceBefore);
  });
});
