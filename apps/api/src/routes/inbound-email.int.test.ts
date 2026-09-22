import {
  createRelay,
  createUser,
  creditTopup,
  getEventById,
  getRelayEmailAddress,
  updateRelay,
  type RelayPublicRow,
  type UserRow,
} from '@smartrelay/db';
import { emailApiModule } from '@smartrelay/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, resetDb, type TestApp } from '../../test/helpers';

let testApp: TestApp;
let user: UserRow;

beforeEach(async () => {
  testApp = buildTestApp({}, { email_api: emailApiModule });
  await resetDb(testApp.ctx.db);
  user = await createUser(testApp.ctx.db, {
    email: `inbound-${Math.random().toString(36).slice(2)}@example.com`,
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

async function relay(configPublic: Record<string, unknown> = {}): Promise<RelayPublicRow> {
  return createRelay(testApp.ctx.db, testApp.ctx.keyring, {
    userId: user.id,
    name: 'inbound relay',
    type: 'email_api',
    inboundDomain: testApp.ctx.env.INBOUND_DOMAIN,
    configPublic: { targetUrl: 'http://127.0.0.1:1/never-reached', ...configPublic },
  });
}

function postmarkPayload(overrides: Record<string, unknown> = {}) {
  return {
    From: 'customer@example.com',
    To: 'placeholder@inbound.localhost',
    Subject: 'New order #1042',
    MessageID: `msg-${Math.random()}`,
    Date: new Date().toISOString(),
    TextBody: 'Name: Ana\nOrder: 1042',
    Headers: [],
    ...overrides,
  };
}

function postInbound(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return testApp.app.inject({
    method: 'POST',
    url: '/inbound/email/postmark',
    headers: { 'content-type': 'application/json', ...headers },
    payload: JSON.stringify(body),
  });
}

describe('routing and auth', () => {
  it('404s for an unconfigured provider', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/inbound/email/mailgun',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(postmarkPayload()),
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects a request with the wrong Basic Auth password when a secret is configured', async () => {
    await testApp.close();
    testApp = buildTestApp(
      { INBOUND_EMAIL_SECRET: 'the-real-secret' },
      { email_api: emailApiModule },
    );
    await resetDb(testApp.ctx.db);
    user = await createUser(testApp.ctx.db, { email: 'auth@example.com', passwordHash: 'h' });

    const wrongAuth = Buffer.from('anything:wrong-secret').toString('base64');
    const response = await postInbound(postmarkPayload(), { authorization: `Basic ${wrongAuth}` });
    expect(response.statusCode).toBe(401);
  });

  it('accepts a request with the correct Basic Auth password', async () => {
    await testApp.close();
    testApp = buildTestApp(
      { INBOUND_EMAIL_SECRET: 'the-real-secret' },
      { email_api: emailApiModule },
    );
    await resetDb(testApp.ctx.db);
    user = await createUser(testApp.ctx.db, { email: 'auth2@example.com', passwordHash: 'h' });
    await topUp(1_000_000n);
    const r = await relay();
    const address = await getRelayEmailAddress(testApp.ctx.db, r.id);

    const goodAuth = Buffer.from('anyuser:the-real-secret').toString('base64');
    const response = await postInbound(postmarkPayload({ To: address }), {
      authorization: `Basic ${goodAuth}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().eventId).toBeTruthy();
  });
});

describe('recipient resolution', () => {
  it('drops mail to an unknown address with 200 and creates no event', async () => {
    const response = await postInbound(postmarkPayload({ To: 'nobody@inbound.localhost' }));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ dropped: true });
  });

  it('drops mail to an inactive relay', async () => {
    const r = await relay();
    const address = await getRelayEmailAddress(testApp.ctx.db, r.id);
    await updateRelay(testApp.ctx.db, testApp.ctx.keyring, user.id, r.id, { status: 'inactive' });

    const response = await postInbound(postmarkPayload({ To: address }));

    expect(response.json()).toEqual({ dropped: true });
  });

  it('prefers OriginalRecipient over To when both are present', async () => {
    await topUp(1_000_000n);
    const r = await relay();
    const address = await getRelayEmailAddress(testApp.ctx.db, r.id);

    const response = await postInbound(
      postmarkPayload({ To: 'someone-else@example.com', OriginalRecipient: address }),
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().eventId).toBeTruthy();
  });
});

describe('loop protection', () => {
  it.each([
    ['Auto-Submitted', 'auto-replied'],
    ['Precedence', 'bulk'],
    ['Precedence', 'auto_reply'],
  ])('drops mail with header %s: %s', async (name, value) => {
    await topUp(1_000_000n);
    const r = await relay();
    const address = await getRelayEmailAddress(testApp.ctx.db, r.id);

    const response = await postInbound(
      postmarkPayload({ To: address, Headers: [{ Name: name, Value: value }] }),
    );

    expect(response.json()).toEqual({ dropped: true });
    const event = response.json().eventId
      ? await getEventById(testApp.ctx.db, response.json().eventId)
      : undefined;
    expect(event).toBeUndefined();
  });

  it('does not drop a normal Auto-Submitted: no header', async () => {
    await topUp(1_000_000n);
    const r = await relay();
    const address = await getRelayEmailAddress(testApp.ctx.db, r.id);

    const response = await postInbound(
      postmarkPayload({ To: address, Headers: [{ Name: 'Auto-Submitted', Value: 'no' }] }),
    );

    expect(response.json().eventId).toBeTruthy();
  });

  it("drops mail sent from the platform's own inbound domain", async () => {
    await topUp(1_000_000n);
    const r = await relay();
    const address = await getRelayEmailAddress(testApp.ctx.db, r.id);

    const response = await postInbound(
      postmarkPayload({ To: address, From: 'bounce@inbound.localhost' }),
    );

    expect(response.json()).toEqual({ dropped: true });
  });
});

describe('filter (Advanced)', () => {
  it('rejects mail that does not match subjectContains, without billing', async () => {
    await topUp(1_000_000n);
    const r = await relay({ filter: { subjectContains: 'invoice' } });
    const address = await getRelayEmailAddress(testApp.ctx.db, r.id);

    const response = await postInbound(
      postmarkPayload({ To: address, Subject: 'New order #1042' }),
    );

    expect(response.json()).toEqual({ rejected: true });
  });

  it('accepts mail that matches the filter', async () => {
    await topUp(1_000_000n);
    const r = await relay({ filter: { subjectContains: 'order' } });
    const address = await getRelayEmailAddress(testApp.ctx.db, r.id);

    const response = await postInbound(
      postmarkPayload({ To: address, Subject: 'New order #1042' }),
    );

    expect(response.json().eventId).toBeTruthy();
  });
});

describe('message-id dedupe', () => {
  it('returns the same eventId for a redelivered message', async () => {
    await topUp(1_000_000n);
    const r = await relay();
    const address = await getRelayEmailAddress(testApp.ctx.db, r.id);
    const payload = postmarkPayload({ To: address, MessageID: 'fixed-message-id' });

    const first = await postInbound(payload);
    const second = await postInbound(payload);

    expect(second.json().eventId).toBe(first.json().eventId);
  });
});

describe('credit check', () => {
  it('holds the event when the balance is below the price', async () => {
    const r = await relay();
    const address = await getRelayEmailAddress(testApp.ctx.db, r.id);

    const response = await postInbound(postmarkPayload({ To: address }));

    expect(response.json().held).toBe(true);
    const event = await getEventById(testApp.ctx.db, response.json().eventId);
    expect(event?.status).toBe('HELD_NO_CREDIT');
  });
});

describe('default output shape', () => {
  it('builds meta/fields/raw from the Postmark payload', async () => {
    await topUp(1_000_000n);
    const r = await relay();
    const address = await getRelayEmailAddress(testApp.ctx.db, r.id);

    const response = await postInbound(
      postmarkPayload({ To: address, TextBody: 'Name: Ana\nOrder: 1042' }),
    );

    const event = await getEventById(testApp.ctx.db, response.json().eventId);
    expect(event?.status).toBe('QUEUED');
    expect(event?.source).toBe('email');
  });
});
