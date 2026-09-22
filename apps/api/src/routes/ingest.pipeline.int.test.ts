import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createRelay,
  createUser,
  creditTopup,
  getBalance,
  getEventById,
  releaseHeldEvents,
  runDeliverJob,
  type DeliverDeps,
  type UserRow,
} from '@smartrelay/db';
import { createSafeHttpClient } from '@smartrelay/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, resetDb, type TestApp } from '../../test/helpers';

/**
 * "Process the deliver job" here means calling packages/db's runDeliverJob directly, the same
 * queue-agnostic function apps/worker's BullMQ processor calls (apps/worker/src/deliver.ts). That
 * keeps this test from importing apps/worker's source, or needing a live BullMQ Worker consuming
 * the queue: the real ingest route still does the enqueueing, so its behaviour is exercised, and
 * the delivery/retry/charge logic itself is already covered exhaustively in
 * packages/db/src/deliver.int.test.ts.
 */

let testApp: TestApp;
let user: UserRow;
let deps: DeliverDeps;
const servers: http.Server[] = [];

beforeEach(async () => {
  testApp = buildTestApp();
  await resetDb(testApp.ctx.db);
  user = await createUser(testApp.ctx.db, {
    email: `pipeline-${Math.random().toString(36).slice(2)}@example.com`,
    passwordHash: 'h',
  });
  deps = {
    keyring: testApp.ctx.keyring,
    modules: testApp.ctx.modules,
    // Test destinations bind to a random ephemeral port, so every port must be allowed (the
    // default allow-list is just 80/443); address-level SSRF checks live in
    // packages/engine/src/safe-http.test.ts and are not what this test is about.
    http: createSafeHttpClient({
      unsafeAllowPrivateAddresses: true,
      allowedPorts: Array.from({ length: 65535 }, (_, i) => i + 1),
    }),
  };
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  await testApp.close();
});

async function startDestination(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

async function topUp(amountMicro: bigint) {
  await creditTopup(testApp.ctx.db, {
    userId: user.id,
    amountMicro,
    providerSessionId: `cs_${Math.random()}`,
  });
}

async function ingestJson(token: string, payload: unknown) {
  return testApp.app.inject({
    method: 'POST',
    url: `/i/${token}`,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(payload),
  });
}

describe('full pipeline: ingest -> deliver -> charge', () => {
  it('posts a webhook and observes SUCCESS + a ledger charge at the module price', async () => {
    await topUp(1_000_000n);
    const url = await startDestination((_req, res) => res.end('ok'));
    const r = await createRelay(testApp.ctx.db, testApp.ctx.keyring, {
      userId: user.id,
      name: 'sms relay',
      type: 'webhook_sms',
      configPublic: { url, template: 'Hi {{$.name}}' },
    });
    const balanceBefore = await getBalance(testApp.ctx.db, user.id);

    const response = await ingestJson(r.ingestToken, { name: 'Ana' });
    expect(response.statusCode).toBe(202);
    const { eventId } = response.json();
    expect((await getEventById(testApp.ctx.db, eventId))?.status).toBe('QUEUED');

    const outcome = await runDeliverJob(testApp.ctx.db, deps, { eventId, attemptNo: 1 });

    expect(outcome).toEqual({ kind: 'success' });
    const event = await getEventById(testApp.ctx.db, eventId);
    expect(event?.status).toBe('SUCCESS');
    expect(event?.costMicro).toBe(25_000n); // webhook_sms -> sms_dispatch
    expect(event?.finalStatusCode).toBe(200);
    expect(await getBalance(testApp.ctx.db, user.id)).toBe(balanceBefore - 25_000n);
  });

  it('reports "retry" for a 500 destination and leaves the event unbilled', async () => {
    await topUp(1_000_000n);
    let calls = 0;
    const url = await startDestination((_req, res) => {
      calls++;
      res.writeHead(500);
      res.end();
    });
    const r = await createRelay(testApp.ctx.db, testApp.ctx.keyring, {
      userId: user.id,
      name: 'always down',
      type: 'chat_relay',
      configPublic: { url, template: '{{$.name}}' },
    });
    const balanceBefore = await getBalance(testApp.ctx.db, user.id);

    const response = await ingestJson(r.ingestToken, { name: 'Ana' });
    const { eventId } = response.json();

    const outcome = await runDeliverJob(testApp.ctx.db, deps, { eventId, attemptNo: 1 });

    expect(outcome.kind).toBe('retry');
    expect(calls).toBe(1);
    const event = await getEventById(testApp.ctx.db, eventId);
    expect(event?.status).toBe('PROCESSING');
    expect(event?.costMicro).toBe(0n);
    expect(await getBalance(testApp.ctx.db, user.id)).toBe(balanceBefore);
  });
});

describe('out-of-credit hold -> top-up -> auto-release', () => {
  it('holds for lack of credit, then delivers and charges once credit is added', async () => {
    const url = await startDestination((_req, res) => res.end('ok'));
    const r = await createRelay(testApp.ctx.db, testApp.ctx.keyring, {
      userId: user.id,
      name: 'sms relay',
      type: 'webhook_sms',
      configPublic: { url, template: 'Hi {{$.name}}' },
    });

    const ingestResponse = await ingestJson(r.ingestToken, { name: 'Ana' });
    expect(ingestResponse.statusCode).toBe(202);
    expect(ingestResponse.json().held).toBe(true);
    const { eventId } = ingestResponse.json();
    expect((await getEventById(testApp.ctx.db, eventId))?.status).toBe('HELD_NO_CREDIT');

    await topUp(1_000_000n);
    const released = await releaseHeldEvents(testApp.ctx.db, user.id);
    expect(released.map((event) => event.id)).toEqual([eventId]);
    expect((await getEventById(testApp.ctx.db, eventId))?.status).toBe('QUEUED');

    const outcome = await runDeliverJob(testApp.ctx.db, deps, { eventId, attemptNo: 1 });

    expect(outcome).toEqual({ kind: 'success' });
    const event = await getEventById(testApp.ctx.db, eventId);
    expect(event?.status).toBe('SUCCESS');
    expect(event?.costMicro).toBe(25_000n);
    expect(await getBalance(testApp.ctx.db, user.id)).toBe(1_000_000n - 25_000n);
  });

  it('releases held events oldest-first', async () => {
    const url = await startDestination((_req, res) => res.end('ok'));
    const r = await createRelay(testApp.ctx.db, testApp.ctx.keyring, {
      userId: user.id,
      name: 'sms relay',
      type: 'webhook_sms',
      configPublic: { url, template: '{{$.n}}' },
    });

    const eventIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const response = await ingestJson(r.ingestToken, { n: i });
      eventIds.push(response.json().eventId);
    }

    await topUp(1_000_000n);
    const released = await releaseHeldEvents(testApp.ctx.db, user.id);
    expect(released.map((event) => event.id)).toEqual(eventIds); // oldest-first, insertion order

    for (const eventId of eventIds) {
      const outcome = await runDeliverJob(testApp.ctx.db, deps, { eventId, attemptNo: 1 });
      expect(outcome).toEqual({ kind: 'success' });
    }
    const statuses = await Promise.all(eventIds.map((id) => getEventById(testApp.ctx.db, id)));
    expect(statuses.every((event) => event?.status === 'SUCCESS')).toBe(true);
  });
});
