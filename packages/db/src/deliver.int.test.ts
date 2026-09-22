import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createSafeHttpClient, Keyring, type ModuleRegistry } from '@smartrelay/engine';
import { createEchoModule } from '@smartrelay/engine/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, createUser, resetDb } from '../test/helpers';
import type { DbHandle } from './client';
import { runDeliverJob, type DeliverDeps } from './deliver';
import { createEvent, getEventById } from './events';
import { creditTopup, getBalance } from './ledger';
import { createRelay } from './relays';

let handle: DbHandle;
let deps: DeliverDeps;

beforeAll(() => {
  handle = createTestDb();
  const modules: ModuleRegistry = {
    webhook_sms: createEchoModule('webhook_sms', 'sms_dispatch'),
    chat_relay: createEchoModule('chat_relay', 'relay_http'),
  };
  deps = {
    keyring: new Keyring({ id: 'k1', key: randomBytes(32) }),
    modules,
    // Test destinations bind to a random ephemeral port, so every port must be allowed (the
    // default allow-list is just 80/443). Address-level SSRF checks are covered elsewhere
    // (packages/engine/src/safe-http.test.ts); this only relaxes what test servers need.
    http: createSafeHttpClient({
      unsafeAllowPrivateAddresses: true,
      allowedPorts: Array.from({ length: 65535 }, (_, i) => i + 1),
    }),
  };
});
afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await resetDb(handle.db);
});

const servers: http.Server[] = [];
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
});

async function startDestination(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

async function newUser(amountMicro = 1_000_000n) {
  const user = await createUser(handle.db);
  if (amountMicro > 0n) {
    await creditTopup(handle.db, {
      userId: user.id,
      amountMicro,
      providerSessionId: `cs_${Math.random()}`,
    });
  }
  return user;
}

async function newRelay(
  userId: string,
  url: string,
  type: 'webhook_sms' | 'chat_relay' = 'webhook_sms',
) {
  return createRelay(handle.db, deps.keyring, {
    userId,
    name: 'test relay',
    type,
    configPublic: { url, template: '{{$.name}}' },
  });
}

async function newEvent(
  relayId: string,
  userId: string,
  status: 'PROCESSING' | 'FAILED' | 'SUCCESS' = 'PROCESSING',
) {
  return createEvent(handle.db, {
    relayId,
    userId,
    source: 'http',
    status,
    payloadIn: { name: 'Ana' },
  });
}

describe('runDeliverJob: success', () => {
  it('charges the event at the module price and marks it SUCCESS', async () => {
    const user = await newUser();
    const url = await startDestination((_req, res) => res.end('ok'));
    const relay = await newRelay(user.id, url);
    const event = await newEvent(relay.id, user.id);
    const before = await getBalance(handle.db, user.id);

    const outcome = await runDeliverJob(handle.db, deps, { eventId: event.id, attemptNo: 1 });

    expect(outcome).toEqual({ kind: 'success' });
    const after = await getEventById(handle.db, event.id);
    expect(after?.status).toBe('SUCCESS');
    expect(after?.costMicro).toBe(25_000n); // webhook_sms -> sms_dispatch price in the test registry
    expect(after?.finalStatusCode).toBe(200);
    expect(await getBalance(handle.db, user.id)).toBe(before - 25_000n);
  });

  it('is idempotent: replaying an already-SUCCESS event charges nothing twice', async () => {
    const user = await newUser();
    const url = await startDestination((_req, res) => res.end('ok'));
    const relay = await newRelay(user.id, url);
    const event = await newEvent(relay.id, user.id);

    await runDeliverJob(handle.db, deps, { eventId: event.id, attemptNo: 1 });
    const balanceAfterFirst = await getBalance(handle.db, user.id);
    const replay = await runDeliverJob(handle.db, deps, { eventId: event.id, attemptNo: 1 });

    expect(replay).toEqual({ kind: 'noop' });
    expect(await getBalance(handle.db, user.id)).toBe(balanceAfterFirst);
  });

  it('is a no-op for an event already FAILED', async () => {
    const user = await newUser();
    const relay = await newRelay(user.id, 'http://127.0.0.1:1/');
    const event = await newEvent(relay.id, user.id, 'FAILED');

    expect(await runDeliverJob(handle.db, deps, { eventId: event.id, attemptNo: 1 })).toEqual({
      kind: 'noop',
    });
  });
});

describe('runDeliverJob: terminal failures (not retryable)', () => {
  it('marks the event FAILED on a 4xx destination response', async () => {
    const user = await newUser();
    const url = await startDestination((_req, res) => {
      res.writeHead(400);
      res.end('bad request');
    });
    const relay = await newRelay(user.id, url);
    const event = await newEvent(relay.id, user.id);
    const before = await getBalance(handle.db, user.id);

    const outcome = await runDeliverJob(handle.db, deps, { eventId: event.id, attemptNo: 1 });

    expect(outcome.kind).toBe('terminal');
    expect((outcome as { errorCode: string }).errorCode).toBe('DESTINATION_ERROR');
    const after = await getEventById(handle.db, event.id);
    expect(after?.status).toBe('FAILED');
    expect(await getBalance(handle.db, user.id)).toBe(before);
  });

  it('marks the event FAILED for a terminal template error (missing variable)', async () => {
    const user = await newUser();
    const relay = await createRelay(handle.db, deps.keyring, {
      userId: user.id,
      name: 'bad template',
      type: 'webhook_sms',
      configPublic: { url: 'http://127.0.0.1:1/', template: '{{$.missing}}' },
    });
    const event = await newEvent(relay.id, user.id);

    const outcome = await runDeliverJob(handle.db, deps, { eventId: event.id, attemptNo: 1 });

    expect(outcome).toMatchObject({ kind: 'terminal', errorCode: 'TEMPLATE_VAR_MISSING' });
    expect((await getEventById(handle.db, event.id))?.errorCode).toBe('TEMPLATE_VAR_MISSING');
  });
});

describe('runDeliverJob: retryable failures', () => {
  it('returns "retry" on a 500 and leaves the event PROCESSING and unbilled', async () => {
    const user = await newUser();
    const url = await startDestination((_req, res) => {
      res.writeHead(503);
      res.end('down');
    });
    const relay = await newRelay(user.id, url);
    const event = await newEvent(relay.id, user.id);

    const outcome = await runDeliverJob(handle.db, deps, { eventId: event.id, attemptNo: 1 });

    expect(outcome.kind).toBe('retry');
    const after = await getEventById(handle.db, event.id);
    expect(after?.status).toBe('PROCESSING');
    expect(after?.costMicro).toBe(0n);
  });

  it.each([1, 2, 3])(
    'stays "retry" without marking FAILED at attemptNo %i (below the max)',
    async (attemptNo) => {
      const user = await newUser();
      const url = await startDestination((_req, res) => {
        res.writeHead(500);
        res.end();
      });
      const relay = await newRelay(user.id, url);
      const event = await newEvent(relay.id, user.id);

      const outcome = await runDeliverJob(handle.db, deps, { eventId: event.id, attemptNo });

      expect(outcome.kind).toBe('retry');
      expect((await getEventById(handle.db, event.id))?.status).toBe('PROCESSING');
    },
  );

  it('marks FAILED but still reports "retry" when the failure happens on the last allowed attempt', async () => {
    const user = await newUser();
    const url = await startDestination((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    const relay = await newRelay(user.id, url);
    const event = await newEvent(relay.id, user.id);

    // DELIVER_MAX_ATTEMPTS = 4 ("1 initial + 3 retries"): attemptNo 4 is the last one.
    const outcome = await runDeliverJob(handle.db, deps, { eventId: event.id, attemptNo: 4 });

    expect(outcome.kind).toBe('retry');
    const after = await getEventById(handle.db, event.id);
    expect(after?.status).toBe('FAILED');
    expect(after?.costMicro).toBe(0n);
  });

  it('treats a network error (unreachable destination) the same way as a 5xx', async () => {
    const user = await newUser();
    const relay = await newRelay(user.id, 'http://127.0.0.1:1/'); // nothing listens on port 1
    const event = await newEvent(relay.id, user.id);

    const outcome = await runDeliverJob(handle.db, deps, { eventId: event.id, attemptNo: 1 });

    expect(outcome.kind).toBe('retry');
    expect((await getEventById(handle.db, event.id))?.status).toBe('PROCESSING');
  });
});

describe('runDeliverJob: pipeline edge cases', () => {
  it('returns terminal EVENT_NOT_FOUND for an event that does not exist', async () => {
    const outcome = await runDeliverJob(handle.db, deps, {
      eventId: '00000000-0000-0000-0000-000000000000',
      attemptNo: 1,
    });
    expect(outcome).toMatchObject({ kind: 'terminal', errorCode: 'EVENT_NOT_FOUND' });
  });

  it('marks FAILED with MODULE_NOT_IMPLEMENTED when no module is registered for the relay type', async () => {
    const user = await newUser();
    const relay = await createRelay(handle.db, deps.keyring, {
      userId: user.id,
      name: 'no module',
      type: 'calendar_bridge',
      configPublic: {},
    });
    const event = await newEvent(relay.id, user.id);
    const bareDeps: DeliverDeps = { ...deps, modules: {} };

    const outcome = await runDeliverJob(handle.db, bareDeps, { eventId: event.id, attemptNo: 1 });

    expect(outcome).toMatchObject({ kind: 'terminal', errorCode: 'MODULE_NOT_IMPLEMENTED' });
    expect((await getEventById(handle.db, event.id))?.errorCode).toBe('MODULE_NOT_IMPLEMENTED');
  });

  it('marks FAILED with RELAY_CONFIG_INVALID when the stored config no longer matches the schema', async () => {
    const user = await newUser();
    const relay = await createRelay(handle.db, deps.keyring, {
      userId: user.id,
      name: 'bad config',
      type: 'webhook_sms',
      configPublic: { url: 123 }, // wrong type: echoConfigSchema requires strings
    });
    const event = await newEvent(relay.id, user.id);

    const outcome = await runDeliverJob(handle.db, deps, { eventId: event.id, attemptNo: 1 });

    expect(outcome).toMatchObject({ kind: 'terminal', errorCode: 'RELAY_CONFIG_INVALID' });
    expect((await getEventById(handle.db, event.id))?.errorCode).toBe('RELAY_CONFIG_INVALID');
  });
});
