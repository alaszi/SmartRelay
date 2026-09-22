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
import { chatRelayModule, createSafeHttpClient } from '@smartrelay/engine';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, resetDb, type TestApp } from '../../test/helpers';

/**
 * End-to-end test for Module 3 (MASTER_PLAN Phase 3 "Done when": ingest -> adapter mock -> ledger
 * charge at the correct price -> log entry), covering both chat_relay platforms.
 */

const mswServer = setupServer();
beforeAll(() => mswServer.listen({ onUnhandledRequest: 'error' }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

let testApp: TestApp;
let user: UserRow;
let deps: DeliverDeps;

beforeEach(async () => {
  testApp = buildTestApp({}, { chat_relay: chatRelayModule });
  await resetDb(testApp.ctx.db);
  user = await createUser(testApp.ctx.db, {
    email: `chat-e2e-${Math.random().toString(36).slice(2)}@example.com`,
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

describe('Module 3 (chat_relay -> Telegram/Discord): full pipeline', () => {
  it('ingests a webhook, sends a MarkdownV2-escaped Telegram message, charges relay_http, and logs a delivery attempt', async () => {
    let seenBody: { chat_id?: string; text?: string } | undefined;
    mswServer.use(
      http.post('https://api.telegram.org/bot123:ABC/sendMessage', async ({ request }) => {
        seenBody = (await request.json()) as typeof seenBody;
        return HttpResponse.json({ ok: true, result: { message_id: 1 } });
      }),
    );

    const relay = await createRelay(testApp.ctx.db, testApp.ctx.keyring, {
      userId: user.id,
      name: 'Order updates (Telegram)',
      type: 'chat_relay',
      configPublic: {
        platform: 'telegram',
        chatId: '999',
        template: 'Order #{{$.order.id}} from {{$.customer.name}}',
      },
      configSecret: { botToken: '123:ABC' },
    });
    const balanceBefore = await getBalance(testApp.ctx.db, user.id);

    const ingestResponse = await testApp.app.inject({
      method: 'POST',
      url: `/i/${relay.ingestToken}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ order: { id: 1042 }, customer: { name: 'Ana.Maria' } }),
    });
    expect(ingestResponse.statusCode).toBe(202);
    const { eventId } = ingestResponse.json();
    expect((await getEventById(testApp.ctx.db, eventId))?.status).toBe('QUEUED');

    const outcome = await runDeliverJob(testApp.ctx.db, deps, { eventId, attemptNo: 1 });
    expect(outcome).toEqual({ kind: 'success' });

    expect(seenBody?.chat_id).toBe('999');
    // Only the substituted "." is escaped; the literal "#" stays untouched.
    expect(seenBody?.text).toBe('Order #1042 from Ana\\.Maria');

    const event = await getEventById(testApp.ctx.db, eventId);
    expect(event?.status).toBe('SUCCESS');
    expect(event?.costMicro).toBe(5_000n); // relay_http = EUR 0.005
    expect(await getBalance(testApp.ctx.db, user.id)).toBe(balanceBefore - 5_000n);
    expect(await countDeliveryAttempts(testApp.ctx.db, eventId)).toBe(1);

    // The bot token is never in the encrypted-blob plaintext exposure surface.
    expect(
      JSON.stringify(event, (_key, value: unknown) =>
        typeof value === 'bigint' ? String(value) : value,
      ),
    ).not.toContain('123:ABC');
  });

  it('ingests a webhook, sends an unescaped Discord message, charges relay_http, and logs a delivery attempt', async () => {
    let seenBody: { content?: string } | undefined;
    mswServer.use(
      http.post('https://discord.com/api/webhooks/1/token', async ({ request }) => {
        seenBody = (await request.json()) as typeof seenBody;
        return new Response(null, { status: 204 });
      }),
    );

    const relay = await createRelay(testApp.ctx.db, testApp.ctx.keyring, {
      userId: user.id,
      name: 'Order updates (Discord)',
      type: 'chat_relay',
      configPublic: {
        platform: 'discord',
        webhookUrl: 'https://discord.com/api/webhooks/1/token',
        template: 'Order #{{$.order.id}} from {{$.customer.name}}',
      },
    });
    const balanceBefore = await getBalance(testApp.ctx.db, user.id);

    const ingestResponse = await testApp.app.inject({
      method: 'POST',
      url: `/i/${relay.ingestToken}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ order: { id: 1042 }, customer: { name: 'Ana.Maria' } }),
    });
    const { eventId } = ingestResponse.json();

    const outcome = await runDeliverJob(testApp.ctx.db, deps, { eventId, attemptNo: 1 });
    expect(outcome).toEqual({ kind: 'success' });

    expect(seenBody?.content).toBe('Order #1042 from Ana.Maria'); // no parse_mode, nothing escaped

    const event = await getEventById(testApp.ctx.db, eventId);
    expect(event?.status).toBe('SUCCESS');
    expect(event?.costMicro).toBe(5_000n);
    expect(await getBalance(testApp.ctx.db, user.id)).toBe(balanceBefore - 5_000n);
    expect(await countDeliveryAttempts(testApp.ctx.db, eventId)).toBe(1);
  });

  it('does not bill on a retryable Telegram 429 (honors Retry-After, not a terminal failure)', async () => {
    mswServer.use(
      http.post('https://api.telegram.org/bot123:ABC/sendMessage', () =>
        HttpResponse.json(
          { ok: false, error_code: 429, description: 'flood' },
          { status: 429, headers: { 'retry-after': '5' } },
        ),
      ),
    );

    const relay = await createRelay(testApp.ctx.db, testApp.ctx.keyring, {
      userId: user.id,
      name: 'Order updates (Telegram)',
      type: 'chat_relay',
      configPublic: { platform: 'telegram', chatId: '999', template: 'Order #{{$.order.id}}' },
      configSecret: { botToken: '123:ABC' },
    });
    const balanceBefore = await getBalance(testApp.ctx.db, user.id);

    const ingestResponse = await testApp.app.inject({
      method: 'POST',
      url: `/i/${relay.ingestToken}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ order: { id: 1 } }),
    });
    const { eventId } = ingestResponse.json();

    const outcome = await runDeliverJob(testApp.ctx.db, deps, { eventId, attemptNo: 1 });

    expect(outcome).toMatchObject({ kind: 'retry', errorCode: 'TELEGRAM_429' });
    const event = await getEventById(testApp.ctx.db, eventId);
    expect(event?.status).toBe('PROCESSING');
    expect(event?.costMicro).toBe(0n);
    expect(await getBalance(testApp.ctx.db, user.id)).toBe(balanceBefore);
  });
});
