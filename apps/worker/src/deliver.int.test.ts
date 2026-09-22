import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createEvent,
  createRelay,
  createUser,
  creditTopup,
  getBalance,
  getEventById,
  type EventRow,
} from '@smartrelay/db';
import { UnrecoverableError, type Job } from 'bullmq';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildTestWorkerContext, resetDb, type TestWorkerContext } from '../test/helpers';
import { createDeliverProcessor } from './deliver';

let testWorker: TestWorkerContext;

beforeAll(() => {
  testWorker = buildTestWorkerContext();
});
afterAll(async () => {
  await testWorker.close();
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

function fakeJob(eventId: string, attemptsMade: number): Job<{ eventId: string }> {
  return { data: { eventId }, attemptsMade } as unknown as Job<{ eventId: string }>;
}

async function newUser(amountMicro = 1_000_000n) {
  const { ctx } = testWorker;
  const user = await createUser(ctx.db, {
    email: `u-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    passwordHash: 'h',
  });
  if (amountMicro > 0n) {
    await creditTopup(ctx.db, {
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
  const { ctx } = testWorker;
  return createRelay(ctx.db, ctx.keyring, {
    userId,
    name: 'test relay',
    type,
    configPublic: { url, template: '{{$.name}}' },
  });
}

async function newEvent(
  relayId: string,
  userId: string,
  status: EventRow['status'] = 'PROCESSING',
) {
  const { ctx } = testWorker;
  return createEvent(ctx.db, {
    relayId,
    userId,
    source: 'http',
    status,
    payloadIn: { name: 'Ana' },
  });
}

describe('createDeliverProcessor: success', () => {
  it('charges the event at the module price and marks it SUCCESS', async () => {
    const { ctx } = testWorker;
    await resetDb(ctx.db);
    const user = await newUser();
    const url = await startDestination((_req, res) => res.end('ok'));
    const relay = await newRelay(user.id, url);
    const event = await newEvent(relay.id, user.id);
    const before = await getBalance(ctx.db, user.id);

    await createDeliverProcessor(ctx)(fakeJob(event.id, 0));

    const after = await getEventById(ctx.db, event.id);
    expect(after?.status).toBe('SUCCESS');
    expect(after?.costMicro).toBe(25_000n); // webhook_sms -> sms_dispatch price in the test registry
    expect(after?.finalStatusCode).toBe(200);
    expect(await getBalance(ctx.db, user.id)).toBe(before - 25_000n);
  });

  it('is idempotent: replaying an already-SUCCESS event charges nothing twice', async () => {
    const { ctx } = testWorker;
    await resetDb(ctx.db);
    const user = await newUser();
    const url = await startDestination((_req, res) => res.end('ok'));
    const relay = await newRelay(user.id, url);
    const event = await newEvent(relay.id, user.id);
    const processor = createDeliverProcessor(ctx);

    await processor(fakeJob(event.id, 0));
    const balanceAfterFirst = await getBalance(ctx.db, user.id);
    await processor(fakeJob(event.id, 0));

    expect(await getBalance(ctx.db, user.id)).toBe(balanceAfterFirst);
  });
});

describe('createDeliverProcessor: terminal failures (not retryable)', () => {
  it('marks the event FAILED and throws UnrecoverableError on a 4xx destination response', async () => {
    const { ctx } = testWorker;
    await resetDb(ctx.db);
    const user = await newUser();
    const url = await startDestination((_req, res) => {
      res.writeHead(400);
      res.end('bad request');
    });
    const relay = await newRelay(user.id, url);
    const event = await newEvent(relay.id, user.id);
    const before = await getBalance(ctx.db, user.id);

    await expect(createDeliverProcessor(ctx)(fakeJob(event.id, 0))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    const after = await getEventById(ctx.db, event.id);
    expect(after?.status).toBe('FAILED');
    expect(after?.errorCode).toBe('DESTINATION_ERROR');
    expect(await getBalance(ctx.db, user.id)).toBe(before);
  });

  it('marks the event FAILED for a terminal template error (missing variable)', async () => {
    const { ctx } = testWorker;
    await resetDb(ctx.db);
    const user = await newUser();
    const relay = await createRelay(ctx.db, ctx.keyring, {
      userId: user.id,
      name: 'bad template',
      type: 'webhook_sms',
      configPublic: { url: 'http://127.0.0.1:1/', template: '{{$.missing}}' },
    });
    const event = await newEvent(relay.id, user.id);

    await expect(createDeliverProcessor(ctx)(fakeJob(event.id, 0))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    expect((await getEventById(ctx.db, event.id))?.errorCode).toBe('TEMPLATE_VAR_MISSING');
  });
});

describe('createDeliverProcessor: retryable failures', () => {
  it('throws a plain Error (not UnrecoverableError) on a 500 before the last attempt, and leaves the event unbilled', async () => {
    const { ctx } = testWorker;
    await resetDb(ctx.db);
    const user = await newUser();
    const url = await startDestination((_req, res) => {
      res.writeHead(503);
      res.end('down');
    });
    const relay = await newRelay(user.id, url);
    const event = await newEvent(relay.id, user.id);

    const error = await createDeliverProcessor(ctx)(fakeJob(event.id, 0)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    const after = await getEventById(ctx.db, event.id);
    expect(after?.status).toBe('PROCESSING');
    expect(after?.costMicro).toBe(0n);
  });

  it.each([1, 2])(
    'records attempt %i as a retryable failure without marking FAILED',
    async (attemptsMade) => {
      const { ctx } = testWorker;
      await resetDb(ctx.db);
      const user = await newUser();
      const url = await startDestination((_req, res) => {
        res.writeHead(500);
        res.end();
      });
      const relay = await newRelay(user.id, url);
      const event = await newEvent(relay.id, user.id);

      await expect(createDeliverProcessor(ctx)(fakeJob(event.id, attemptsMade))).rejects.toThrow();

      expect((await getEventById(ctx.db, event.id))?.status).toBe('PROCESSING');
    },
  );

  it('marks FAILED (without UnrecoverableError) when a retryable failure happens on the last attempt', async () => {
    const { ctx } = testWorker;
    await resetDb(ctx.db);
    const user = await newUser();
    const url = await startDestination((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    const relay = await newRelay(user.id, url);
    const event = await newEvent(relay.id, user.id);

    // attemptsMade=3 -> attemptNo=4 -> DELIVER_MAX_ATTEMPTS (last of "1 initial + 3 retries").
    const error = await createDeliverProcessor(ctx)(fakeJob(event.id, 3)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    const after = await getEventById(ctx.db, event.id);
    expect(after?.status).toBe('FAILED');
    expect(after?.costMicro).toBe(0n);
  });

  it('retries network errors (SSRF-blocked / unreachable) the same way as a 5xx', async () => {
    const { ctx } = testWorker;
    await resetDb(ctx.db);
    const user = await newUser();
    const relay = await newRelay(user.id, 'http://127.0.0.1:1/'); // nothing listens on port 1
    const event = await newEvent(relay.id, user.id);

    await expect(createDeliverProcessor(ctx)(fakeJob(event.id, 0))).rejects.not.toBeInstanceOf(
      UnrecoverableError,
    );
    expect((await getEventById(ctx.db, event.id))?.status).toBe('PROCESSING');
  });
});

describe('createDeliverProcessor: pipeline edge cases', () => {
  it('throws UnrecoverableError for a job whose event no longer exists', async () => {
    await expect(
      createDeliverProcessor(testWorker.ctx)(fakeJob('00000000-0000-0000-0000-000000000000', 0)),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('is a no-op for an event already FAILED (does not re-throw or re-attempt)', async () => {
    const { ctx } = testWorker;
    await resetDb(ctx.db);
    const user = await newUser();
    const relay = await newRelay(user.id, 'http://127.0.0.1:1/');
    const event = await newEvent(relay.id, user.id, 'FAILED');

    await expect(createDeliverProcessor(ctx)(fakeJob(event.id, 0))).resolves.toBeUndefined();
  });

  it('marks FAILED with MODULE_NOT_IMPLEMENTED when no module is registered for the relay type', async () => {
    const { ctx } = testWorker;
    await resetDb(ctx.db);
    const user = await newUser();
    const relay = await createRelay(ctx.db, ctx.keyring, {
      userId: user.id,
      name: 'no module',
      type: 'email_api',
      configPublic: {},
    });
    const event = await newEvent(relay.id, user.id);
    const bareCtx = { ...ctx, modules: {} };

    await expect(createDeliverProcessor(bareCtx)(fakeJob(event.id, 0))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect((await getEventById(ctx.db, event.id))?.errorCode).toBe('MODULE_NOT_IMPLEMENTED');
  });

  it('marks FAILED with RELAY_CONFIG_INVALID when the stored config no longer matches the schema', async () => {
    const { ctx } = testWorker;
    await resetDb(ctx.db);
    const user = await newUser();
    const relay = await createRelay(ctx.db, ctx.keyring, {
      userId: user.id,
      name: 'bad config',
      type: 'webhook_sms',
      configPublic: { url: 123 }, // wrong type: echoConfigSchema requires strings
    });
    const event = await newEvent(relay.id, user.id);

    await expect(createDeliverProcessor(ctx)(fakeJob(event.id, 0))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect((await getEventById(ctx.db, event.id))?.errorCode).toBe('RELAY_CONFIG_INVALID');
  });
});
