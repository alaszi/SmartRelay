import { consumeEmailVerifyToken, createEvent, createRelay } from '@smartrelay/db';
import { hashToken } from '@smartrelay/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, resetDb, TEST_APP_URL, type TestApp } from '../../test/helpers';

let testApp: TestApp;
let cookie: string;
let userId: string;
let relayId: string;

beforeEach(async () => {
  testApp = buildTestApp();
  await resetDb(testApp.ctx.db);

  const response = await testApp.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { origin: TEST_APP_URL },
    payload: { email: 'logs@example.com', password: 'hunter22' },
  });
  cookie = `sr_session=${response.cookies.find((c) => c.name === 'sr_session')!.value}`;
  userId = (response.json() as { id: string }).id;
  const link = testApp.mailer.sent.at(-1)?.text ?? '';
  const token = new URL(link.split(': ')[1] ?? '', TEST_APP_URL).searchParams.get('token')!;
  await consumeEmailVerifyToken(testApp.ctx.db, hashToken(token));

  const relay = await createRelay(testApp.ctx.db, testApp.ctx.keyring, {
    userId,
    name: 'My relay',
    type: 'chat_relay',
    configPublic: { url: 'https://example.com', template: 'hi' },
  });
  relayId = relay.id;
});
afterEach(async () => {
  await testApp.close();
});

describe('GET /api/logs', () => {
  it('lists events newest-first, with the relay name attached', async () => {
    await createEvent(testApp.ctx.db, {
      relayId,
      userId,
      source: 'http',
      status: 'FAILED',
      errorCode: 'X',
    });
    await createEvent(testApp.ctx.db, { relayId, userId, source: 'http', status: 'SUCCESS' });

    const response = await testApp.app.inject({
      method: 'GET',
      url: '/api/logs',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.events).toHaveLength(2);
    expect(body.events[0].relayName).toBe('My relay');
    expect(body.nextCursor).toBeNull();
  });

  it('filters by status', async () => {
    await createEvent(testApp.ctx.db, { relayId, userId, source: 'http', status: 'FAILED' });
    await createEvent(testApp.ctx.db, { relayId, userId, source: 'http', status: 'SUCCESS' });

    const response = await testApp.app.inject({
      method: 'GET',
      url: '/api/logs?status=FAILED',
      headers: { cookie },
    });

    expect(response.json().events).toHaveLength(1);
    expect(response.json().events[0].status).toBe('FAILED');
  });

  it('requires authentication', async () => {
    const response = await testApp.app.inject({ method: 'GET', url: '/api/logs' });
    expect(response.statusCode).toBe(401);
  });
});

describe('GET /api/logs/:eventId', () => {
  it('returns event metadata, payload, and attempts', async () => {
    const event = await createEvent(testApp.ctx.db, {
      relayId,
      userId,
      source: 'http',
      status: 'SUCCESS',
      payloadIn: { hello: 'world' },
    });

    const response = await testApp.app.inject({
      method: 'GET',
      url: `/api/logs/${event.id}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.event.id).toBe(event.id);
    expect(body.payload.in).toEqual({ hello: 'world' });
    expect(body.attempts).toEqual([]);
  });

  it("404s for another user's event", async () => {
    const event = await createEvent(testApp.ctx.db, {
      relayId,
      userId,
      source: 'http',
      status: 'SUCCESS',
    });

    const other = await testApp.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { origin: TEST_APP_URL },
      payload: { email: 'stranger@example.com', password: 'hunter22' },
    });
    const otherCookie = `sr_session=${other.cookies.find((c) => c.name === 'sr_session')!.value}`;

    const response = await testApp.app.inject({
      method: 'GET',
      url: `/api/logs/${event.id}`,
      headers: { cookie: otherCookie },
    });
    expect(response.statusCode).toBe(404);
  });
});
