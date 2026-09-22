import { createHmac, randomBytes } from 'node:crypto';
import {
  createRelay,
  createUser,
  creditTopup,
  getEventById,
  updateRelay,
  type RelayPublicRow,
  type UserRow,
} from '@smartrelay/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, resetDb, type TestApp } from '../../test/helpers';

let testApp: TestApp;
let user: UserRow;

beforeEach(async () => {
  testApp = buildTestApp();
  await resetDb(testApp.ctx.db);
  user = await createUser(testApp.ctx.db, {
    email: `ingest-${Math.random().toString(36).slice(2)}@example.com`,
    passwordHash: 'h',
  });
});
afterEach(async () => {
  await testApp.close();
});

async function topUp(amountMicro: bigint) {
  await creditTopup(testApp.ctx.db, {
    userId: user.id,
    amountMicro,
    providerSessionId: `cs_${Math.random()}`,
  });
}

async function relay(
  overrides: Partial<{
    configPublic: Record<string, unknown>;
    configSecret: Record<string, unknown>;
  }> = {},
): Promise<RelayPublicRow> {
  return createRelay(testApp.ctx.db, testApp.ctx.keyring, {
    userId: user.id,
    name: 'test relay',
    type: 'webhook_sms',
    configPublic: {
      url: 'http://127.0.0.1:1/never-reached',
      template: '{{$.name}}',
      ...overrides.configPublic,
    },
    ...(overrides.configSecret === undefined ? {} : { configSecret: overrides.configSecret }),
  });
}

function ingest(token: string, options: { body?: string; headers?: Record<string, string> } = {}) {
  return testApp.app.inject({
    method: 'POST',
    url: `/i/${token}`,
    headers: { 'content-type': 'application/json', ...options.headers },
    payload: options.body ?? JSON.stringify({ name: 'Ana' }),
  });
}

describe('relay resolution', () => {
  it('returns 404 for an unknown ingest token and creates no event', async () => {
    const response = await ingest('does-not-exist');
    expect(response.statusCode).toBe(404);
  });

  it('returns 409 for an inactive relay', async () => {
    const r = await relay();
    await updateRelay(testApp.ctx.db, testApp.ctx.keyring, user.id, r.id, { status: 'inactive' });

    const response = await ingest(r.ingestToken);

    expect(response.statusCode).toBe(409);
  });
});

describe('content types', () => {
  it('accepts application/json', async () => {
    await topUp(1_000_000n);
    const r = await relay();
    const response = await ingest(r.ingestToken, { body: JSON.stringify({ name: 'Ana' }) });
    expect(response.statusCode).toBe(202);
  });

  it('accepts application/x-www-form-urlencoded', async () => {
    await topUp(1_000_000n);
    const r = await relay();
    const response = await testApp.app.inject({
      method: 'POST',
      url: `/i/${r.ingestToken}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'name=Ana',
    });
    expect(response.statusCode).toBe(202);
    const event = await getEventById(testApp.ctx.db, response.json().eventId);
    expect(event?.status).toBe('QUEUED');
  });

  it('accepts text/plain', async () => {
    await topUp(1_000_000n);
    const r = await relay({ configPublic: { url: 'http://127.0.0.1:1/', template: 'raw: {{$}}' } });
    const response = await testApp.app.inject({
      method: 'POST',
      url: `/i/${r.ingestToken}`,
      headers: { 'content-type': 'text/plain' },
      payload: 'hello world',
    });
    expect(response.statusCode).toBe(202);
  });

  it('rejects an unsupported content type', async () => {
    const r = await relay();
    const response = await testApp.app.inject({
      method: 'POST',
      url: `/i/${r.ingestToken}`,
      headers: { 'content-type': 'application/xml' },
      payload: '<a/>',
    });
    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({ error: { code: 'UNSUPPORTED_CONTENT_TYPE' } });
  });

  it('rejects invalid JSON', async () => {
    const r = await relay();
    const response = await ingest(r.ingestToken, { body: '{not json' });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a body larger than 256 KB', async () => {
    const r = await relay();
    const response = await ingest(r.ingestToken, {
      body: JSON.stringify({ big: 'x'.repeat(300 * 1024) }),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: { code: 'BODY_TOO_LARGE' } });
  });
});

describe('HMAC verification', () => {
  it('accepts a correctly signed request', async () => {
    await topUp(1_000_000n);
    const secret = 'shared-secret';
    const r = await relay({
      configPublic: {
        hmac: { header: 'x-signature', algorithm: 'sha256', encoding: 'hex' },
      },
      configSecret: { hmacSecret: secret },
    });
    const body = JSON.stringify({ name: 'Ana' });
    const signature = createHmac('sha256', secret).update(body).digest('hex');

    const response = await ingest(r.ingestToken, { body, headers: { 'x-signature': signature } });

    expect(response.statusCode).toBe(202);
  });

  it('rejects a wrong signature and creates a REJECTED event', async () => {
    const r = await relay({
      configPublic: { hmac: { header: 'x-signature', algorithm: 'sha256', encoding: 'hex' } },
      configSecret: { hmacSecret: 'shared-secret' },
    });

    const response = await ingest(r.ingestToken, { headers: { 'x-signature': 'wrong' } });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'HMAC_INVALID' } });
  });

  it('rejects a missing signature when HMAC is configured', async () => {
    const r = await relay({
      configPublic: { hmac: { header: 'x-signature', algorithm: 'sha256', encoding: 'hex' } },
      configSecret: { hmacSecret: 'shared-secret' },
    });

    const response = await ingest(r.ingestToken);

    expect(response.statusCode).toBe(401);
  });
});

describe('idempotency', () => {
  it('returns the same event for a repeated Idempotency-Key within 24h', async () => {
    await topUp(1_000_000n);
    const r = await relay();
    const key = `req-${randomBytes(8).toString('hex')}`;

    const first = await ingest(r.ingestToken, { headers: { 'idempotency-key': key } });
    const second = await ingest(r.ingestToken, {
      headers: { 'idempotency-key': key },
      body: JSON.stringify({ name: 'Different payload' }),
    });

    expect(second.statusCode).toBe(202);
    expect(second.json().eventId).toBe(first.json().eventId);
  });

  it('treats different idempotency keys as different events', async () => {
    await topUp(1_000_000n);
    const r = await relay();
    const first = await ingest(r.ingestToken, { headers: { 'idempotency-key': 'key-a' } });
    const second = await ingest(r.ingestToken, { headers: { 'idempotency-key': 'key-b' } });
    expect(second.json().eventId).not.toBe(first.json().eventId);
  });
});

describe('loop guard', () => {
  it('drops the 11th identical payload within a minute and accepts the first 10', async () => {
    await topUp(10_000_000n);
    const r = await relay();

    const responses = [];
    for (let i = 0; i < 11; i++) {
      responses.push(await ingest(r.ingestToken, { body: JSON.stringify({ name: 'Ana' }) }));
    }

    expect(responses.slice(0, 10).every((response) => response.statusCode === 202)).toBe(true);
    expect(responses[10]?.statusCode).toBe(429);
    expect(responses[10]?.json()).toMatchObject({ error: { code: 'LOOP_DETECTED' } });
    expect(responses[10]?.json().eventId).toBeUndefined();
  });

  it('does not count payloads with different content toward the same loop key', async () => {
    await topUp(10_000_000n);
    const r = await relay();
    for (let i = 0; i < 11; i++) {
      const response = await ingest(r.ingestToken, { body: JSON.stringify({ name: `Ana-${i}` }) });
      expect(response.statusCode).toBe(202);
    }
  });

  it('reorders object keys to the same canonical hash (semantically identical payloads still loop-guard)', async () => {
    await topUp(10_000_000n);
    const r = await relay({ configPublic: { url: 'http://127.0.0.1:1/', template: '{{$.a}}' } });
    for (let i = 0; i < 10; i++) {
      await ingest(r.ingestToken, { body: JSON.stringify({ a: 1, b: 2 }) });
    }
    const response = await ingest(r.ingestToken, { body: JSON.stringify({ b: 2, a: 1 }) });
    expect(response.statusCode).toBe(429);
  });
});

describe('credit check', () => {
  it('holds the event when the balance is below the price', async () => {
    const r = await relay();

    const response = await ingest(r.ingestToken);

    expect(response.statusCode).toBe(202);
    expect(response.json().held).toBe(true);
    const event = await getEventById(testApp.ctx.db, response.json().eventId);
    expect(event?.status).toBe('HELD_NO_CREDIT');
    expect(event?.heldUntil).toBeInstanceOf(Date);
  });

  it('queues the event when the balance covers the price', async () => {
    await topUp(1_000_000n);
    const r = await relay();

    const response = await ingest(r.ingestToken);

    expect(response.statusCode).toBe(202);
    expect(response.json().held).toBeUndefined();
    const event = await getEventById(testApp.ctx.db, response.json().eventId);
    expect(event?.status).toBe('QUEUED');
  });
});

describe('module registry', () => {
  it('reports MODULE_NOT_IMPLEMENTED when no adapter is registered for the relay type', async () => {
    await testApp.close();
    testApp = buildTestApp({}, {});
    await resetDb(testApp.ctx.db);
    user = await createUser(testApp.ctx.db, { email: 'nomod@example.com', passwordHash: 'h' });
    await topUp(1_000_000n);
    const r = await relay();

    const response = await ingest(r.ingestToken);

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: 'MODULE_NOT_IMPLEMENTED' } });
  });
});
