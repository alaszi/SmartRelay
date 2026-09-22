import {
  consumeEmailVerifyToken,
  creditTopup,
  decryptRelaySecret,
  getRelayInternal,
} from '@smartrelay/db';
import { chatRelayModule, hashToken } from '@smartrelay/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, resetDb, TEST_APP_URL, type TestApp } from '../../test/helpers';

let testApp: TestApp;
let cookie: string;
let userId: string;

// The test app's default module registry maps every relay type to the echo test module
// (packages/engine/src/testing.ts), whose configSchema requires exactly { url, template }.
const ECHO_CONFIG = { url: 'https://example.com/hook', template: 'hi' };

async function registerAndVerify(email: string): Promise<{ cookie: string; userId: string }> {
  const response = await testApp.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { origin: TEST_APP_URL },
    payload: { email, password: 'hunter22' },
  });
  const sessionCookie = `sr_session=${response.cookies.find((c) => c.name === 'sr_session')!.value}`;
  const { id } = response.json() as { id: string };

  const link = testApp.mailer.sent.at(-1)?.text ?? '';
  const token = new URL(link.split(': ')[1] ?? '', TEST_APP_URL).searchParams.get('token')!;
  await consumeEmailVerifyToken(testApp.ctx.db, hashToken(token));

  return { cookie: sessionCookie, userId: id };
}

beforeEach(async () => {
  testApp = buildTestApp();
  await resetDb(testApp.ctx.db);
  ({ cookie, userId } = await registerAndVerify('owner@example.com'));
});
afterEach(async () => {
  await testApp.close();
});

function req(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  opts: { payload?: Record<string, unknown>; cookie?: string | null } = {},
) {
  const headers: Record<string, string> = { origin: TEST_APP_URL };
  const useCookie = opts.cookie === null ? undefined : (opts.cookie ?? cookie);
  if (useCookie) headers['cookie'] = useCookie;
  return testApp.app.inject({
    method,
    url,
    headers,
    ...(opts.payload === undefined ? {} : { payload: opts.payload }),
  });
}

describe('POST /api/relays', () => {
  it('creates a relay and never returns configSecret', async () => {
    const response = await req('POST', '/api/relays', {
      payload: {
        name: 'My SMS relay',
        type: 'webhook_sms',
        configPublic: ECHO_CONFIG,
        configSecret: { apiKey: 'super-secret' },
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.relay).toMatchObject({
      name: 'My SMS relay',
      type: 'webhook_sms',
      status: 'active',
    });
    expect('configSecret' in body.relay).toBe(false);
    expect(JSON.stringify(body)).not.toContain('super-secret');
  });

  it('requires authentication', async () => {
    const response = await req('POST', '/api/relays', {
      payload: { name: 'x', type: 'chat_relay' },
      cookie: null,
    });
    expect(response.statusCode).toBe(401);
  });

  it('requires a verified email', async () => {
    const { cookie: unverifiedCookie } = await (async () => {
      const response = await testApp.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers: { origin: TEST_APP_URL },
        payload: { email: 'unverified@example.com', password: 'hunter22' },
      });
      return {
        cookie: `sr_session=${response.cookies.find((c) => c.name === 'sr_session')!.value}`,
      };
    })();

    const response = await req('POST', '/api/relays', {
      payload: { name: 'x', type: 'chat_relay' },
      cookie: unverifiedCookie,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'EMAIL_NOT_VERIFIED' } });
  });

  it('rejects an invalid relay type', async () => {
    const response = await req('POST', '/api/relays', {
      payload: { name: 'x', type: 'not_a_type' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('rejects a request from the wrong origin', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/relays',
      headers: { cookie, origin: 'https://evil.example' },
      payload: { name: 'x', type: 'chat_relay' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('enforces the 25-relay limit', async () => {
    for (let i = 0; i < 25; i++) {
      const response = await req('POST', '/api/relays', {
        payload: { name: `r${i}`, type: 'chat_relay', configPublic: ECHO_CONFIG },
      });
      expect(response.statusCode).toBe(201);
    }
    const over = await req('POST', '/api/relays', {
      payload: { name: 'one too many', type: 'chat_relay', configPublic: ECHO_CONFIG },
    });
    expect(over.statusCode).toBe(409);
    expect(over.json()).toMatchObject({ error: { code: 'LIMIT_REACHED' } });
  });
});

describe('GET /api/relays and /api/relays/:id', () => {
  it("lists only the caller's relays", async () => {
    await req('POST', '/api/relays', {
      payload: { name: 'mine', type: 'chat_relay', configPublic: ECHO_CONFIG },
    });
    const { cookie: otherCookie } = await registerAndVerify('other@example.com');
    await req('POST', '/api/relays', {
      payload: { name: 'theirs', type: 'chat_relay', configPublic: ECHO_CONFIG },
      cookie: otherCookie,
    });

    const mine = await req('GET', '/api/relays');
    expect(mine.json().relays).toHaveLength(1);
    expect(mine.json().relays[0].name).toBe('mine');
  });

  it('404s for a relay owned by someone else', async () => {
    const created = await req('POST', '/api/relays', {
      payload: { name: 'x', type: 'chat_relay', configPublic: ECHO_CONFIG },
    });
    const relayId = created.json().relay.id as string;
    const { cookie: otherCookie } = await registerAndVerify('stranger@example.com');

    const response = await req('GET', `/api/relays/${relayId}`, { cookie: otherCookie });
    expect(response.statusCode).toBe(404);
  });

  it('404s for a well-formed but unknown id', async () => {
    const response = await req('GET', '/api/relays/00000000-0000-0000-0000-000000000000');
    expect(response.statusCode).toBe(404);
  });
});

describe('PATCH /api/relays/:id', () => {
  it('updates fields and refuses another owner', async () => {
    const created = await req('POST', '/api/relays', {
      payload: { name: 'old', type: 'chat_relay', configPublic: ECHO_CONFIG },
    });
    const relayId = created.json().relay.id as string;

    const updated = await req('PATCH', `/api/relays/${relayId}`, {
      payload: { name: 'new', status: 'inactive' },
    });
    expect(updated.json().relay).toMatchObject({ name: 'new', status: 'inactive' });

    const { cookie: otherCookie } = await registerAndVerify('patcher@example.com');
    const forbidden = await req('PATCH', `/api/relays/${relayId}`, {
      payload: { name: 'hijacked' },
      cookie: otherCookie,
    });
    expect(forbidden.statusCode).toBe(404);
  });
});

describe('DELETE /api/relays/:id', () => {
  it('deletes the relay and 404s afterward', async () => {
    const created = await req('POST', '/api/relays', {
      payload: { name: 'x', type: 'chat_relay', configPublic: ECHO_CONFIG },
    });
    const relayId = created.json().relay.id as string;

    const deleted = await req('DELETE', `/api/relays/${relayId}`);
    expect(deleted.statusCode).toBe(204);

    const after = await req('GET', `/api/relays/${relayId}`);
    expect(after.statusCode).toBe(404);
  });
});

describe('POST /api/relays/:id/rotate-token', () => {
  it('replaces the ingest token', async () => {
    const created = await req('POST', '/api/relays', {
      payload: { name: 'x', type: 'webhook_sms', configPublic: ECHO_CONFIG },
    });
    const relay = created.json().relay;

    const rotated = await req('POST', `/api/relays/${relay.id}/rotate-token`);

    expect(rotated.json().relay.ingestToken).not.toBe(relay.ingestToken);
  });
});

describe('POST /api/relays/:id/test', () => {
  it('performs a real delivery, bills it, and logs it with source=test (decision D9)', async () => {
    await creditTopup(testApp.ctx.db, {
      userId,
      amountMicro: 1_000_000n,
      providerSessionId: `cs_${Math.random()}`,
    });

    const created = await req('POST', '/api/relays', {
      payload: {
        name: 'x',
        type: 'chat_relay',
        configPublic: { url: 'http://127.0.0.1:1/unused', template: 'hi {{$.name}}' },
      },
    });
    const relayId = created.json().relay.id as string;

    const response = await req('POST', `/api/relays/${relayId}/test`, {
      payload: { payload: { name: 'Ana' } },
    });

    // The echo module tries a real HTTP call to an unreachable address, so this is a retryable
    // failure — proving the pipeline actually ran (not billed), rather than asserting on a
    // specific provider response body.
    expect(response.statusCode).toBe(200);
    expect(response.json().outcome.kind).toBe('retry');
    expect(response.json().event.status).toBe('PROCESSING');
  });

  it('404s for a relay owned by someone else', async () => {
    const created = await req('POST', '/api/relays', {
      payload: { name: 'x', type: 'chat_relay', configPublic: ECHO_CONFIG },
    });
    const relayId = created.json().relay.id as string;
    const { cookie: otherCookie } = await registerAndVerify('tester@example.com');

    const response = await req('POST', `/api/relays/${relayId}/test`, {
      payload: { payload: {} },
      cookie: otherCookie,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('creating a relay before its destination config exists', () => {
  it("POST /api/relays succeeds with only name + type (the web wizard's step 1)", async () => {
    const response = await req('POST', '/api/relays', {
      payload: { name: 'Draft relay', type: 'chat_relay' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().relay).toMatchObject({ name: 'Draft relay', configPublic: {} });
  });

  it('rejects an invalid config when one is actually supplied at creation', async () => {
    const response = await req('POST', '/api/relays', {
      payload: { name: 'x', type: 'webhook_sms', configPublic: { bogus: true } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });
});

describe('PATCH /api/relays/:id auto-provisions a Telegram callback secret', () => {
  it('generates tgCallbackSecret the first time a relay becomes a telegram chat_relay', async () => {
    const telegramTestApp = buildTestApp({}, { chat_relay: chatRelayModule });
    await resetDb(telegramTestApp.ctx.db);
    try {
      const register = await telegramTestApp.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers: { origin: TEST_APP_URL },
        payload: { email: 'tg-owner@example.com', password: 'hunter22' },
      });
      const tgCookie = `sr_session=${register.cookies.find((c) => c.name === 'sr_session')!.value}`;
      const link = telegramTestApp.mailer.sent.at(-1)?.text ?? '';
      const token = new URL(link.split(': ')[1] ?? '', TEST_APP_URL).searchParams.get('token')!;
      await consumeEmailVerifyToken(telegramTestApp.ctx.db, hashToken(token));

      const created = await telegramTestApp.app.inject({
        method: 'POST',
        url: '/api/relays',
        headers: { origin: TEST_APP_URL, cookie: tgCookie },
        payload: { name: 'Order updates', type: 'chat_relay' },
      });
      const relayId = created.json().relay.id as string;

      const updated = await telegramTestApp.app.inject({
        method: 'PATCH',
        url: `/api/relays/${relayId}`,
        headers: { origin: TEST_APP_URL, cookie: tgCookie },
        payload: {
          configPublic: { platform: 'telegram', chatId: '999', template: 'hi' },
          configSecret: { botToken: '123:ABC' },
        },
      });
      expect(updated.statusCode).toBe(200);

      const internal = await getRelayInternal(telegramTestApp.ctx.db, relayId);
      const secretFields = decryptRelaySecret(telegramTestApp.ctx.keyring, internal!);
      expect(typeof secretFields['tgCallbackSecret']).toBe('string');
      expect((secretFields['tgCallbackSecret'] as string).length).toBeGreaterThanOrEqual(32);
      expect(secretFields['botToken']).toBe('123:ABC'); // the rest of the secret is preserved
    } finally {
      await telegramTestApp.close();
    }
  });
});
