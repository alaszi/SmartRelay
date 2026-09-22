import {
  createRelay,
  createUser,
  decryptRelaySecret,
  getEventById,
  getRelayInternal,
  listEventsForRelay,
  type UserRow,
} from '@smartrelay/db';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, resetDb, type TestApp } from '../../test/helpers';

/**
 * Integration tests for `POST /tg/:relayId/:secret` (MASTER_PLAN section 6, decision D5): Telegram
 * inline-button callbacks are logged as an inbound event and acknowledged, with no forwarding.
 */

const mswServer = setupServer();
beforeAll(() => mswServer.listen({ onUnhandledRequest: 'error' }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

let testApp: TestApp;
let user: UserRow;

beforeEach(async () => {
  testApp = buildTestApp();
  await resetDb(testApp.ctx.db);
  user = await createUser(testApp.ctx.db, {
    email: `tg-cb-${Math.random().toString(36).slice(2)}@example.com`,
    passwordHash: 'h',
  });
});
afterEach(async () => {
  await testApp.close();
});

async function createTelegramRelay(): Promise<{ id: string; secret: string }> {
  const relay = await createRelay(testApp.ctx.db, testApp.ctx.keyring, {
    userId: user.id,
    name: 'Order updates (Telegram)',
    type: 'chat_relay',
    configPublic: { platform: 'telegram', chatId: '999', template: 'Order #{{$.order.id}}' },
    configSecret: { botToken: '123:ABC' },
  });
  const internal = await getRelayInternal(testApp.ctx.db, relay.id);
  if (!internal) throw new Error('relay disappeared');
  const secretFields = decryptRelaySecret(testApp.ctx.keyring, internal);
  return { id: relay.id, secret: secretFields['tgCallbackSecret'] as string };
}

describe('POST /tg/:relayId/:secret', () => {
  it('logs a callback_query event and acknowledges it', async () => {
    let acknowledged = false;
    mswServer.use(
      http.post('https://api.telegram.org/bot123:ABC/answerCallbackQuery', async ({ request }) => {
        const body = (await request.json()) as { callback_query_id?: string };
        acknowledged = body.callback_query_id === 'cbq_1';
        return HttpResponse.json({ ok: true, result: true });
      }),
    );
    const { id, secret } = await createTelegramRelay();

    const response = await testApp.app.inject({
      method: 'POST',
      url: `/tg/${id}/${secret}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        update_id: 1,
        callback_query: {
          id: 'cbq_1',
          data: 'confirm:1042',
          from: { id: 555, username: 'ana' },
        },
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(acknowledged).toBe(true);

    const events = await listEventsForRelay(testApp.ctx.db, id);
    expect(events).toHaveLength(1);
    expect(events[0]?.source).toBe('telegram_callback');
    expect(events[0]?.status).toBe('SUCCESS');
    expect(events[0]?.costMicro).toBe(0n);
    const event = await getEventById(testApp.ctx.db, events[0]?.id ?? '');
    expect(event?.finishedAt).not.toBeNull();
  });

  it('rejects an unknown relay id', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/tg/00000000-0000-0000-0000-000000000000/whatever',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects a non-telegram chat_relay relay', async () => {
    const relay = await createRelay(testApp.ctx.db, testApp.ctx.keyring, {
      userId: user.id,
      name: 'Order updates (Discord)',
      type: 'chat_relay',
      configPublic: {
        platform: 'discord',
        webhookUrl: 'https://discord.com/api/webhooks/1/token',
        template: 'x',
      },
    });
    const response = await testApp.app.inject({
      method: 'POST',
      url: `/tg/${relay.id}/whatever`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects a wrong callback secret without touching Telegram', async () => {
    mswServer.use(http.all('*', () => new Response('should not be called', { status: 500 })));
    const { id } = await createTelegramRelay();

    const response = await testApp.app.inject({
      method: 'POST',
      url: `/tg/${id}/not-the-real-secret`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({}),
    });

    expect(response.statusCode).toBe(401);
    const events = await listEventsForRelay(testApp.ctx.db, id);
    expect(events).toHaveLength(0);
  });

  it('acknowledges 200 for an update with no callback_query, and does not log an event', async () => {
    mswServer.use(http.all('*', () => new Response('should not be called', { status: 500 })));
    const { id, secret } = await createTelegramRelay();

    const response = await testApp.app.inject({
      method: 'POST',
      url: `/tg/${id}/${secret}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ update_id: 2 }),
    });

    expect(response.statusCode).toBe(200);
    const events = await listEventsForRelay(testApp.ctx.db, id);
    expect(events).toHaveLength(0);
  });
});
