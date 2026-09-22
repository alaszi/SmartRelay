import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createEvent, createRelay, createUser, creditTopup, getEventById } from '@smartrelay/db';
import { UnrecoverableError, type Job } from 'bullmq';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestWorkerContext, resetDb, type TestWorkerContext } from '../test/helpers';
import { createDeliverProcessor } from './deliver';

/**
 * The actual delivery logic (module execution, retry classification, charging) is tested
 * exhaustively in packages/db/src/deliver.int.test.ts against runDeliverJob directly. This file
 * only proves the thin BullMQ adapter wiring: does each `DeliverOutcome.kind` get translated into
 * the right throw/return behaviour for BullMQ to act on.
 */

let testWorker: TestWorkerContext;

beforeAll(() => {
  testWorker = buildTestWorkerContext();
});
afterAll(async () => {
  await testWorker.close();
});
beforeEach(async () => {
  await resetDb(testWorker.ctx.db);
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

async function startDestination(status: number): Promise<string> {
  const server = http.createServer((_req, res) => {
    res.writeHead(status);
    res.end(status < 300 ? 'ok' : 'no');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

function fakeJob(eventId: string, attemptsMade: number): Job<{ eventId: string }> {
  return { data: { eventId }, attemptsMade } as unknown as Job<{ eventId: string }>;
}

async function setup(url: string, amountMicro = 1_000_000n) {
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
  const relay = await createRelay(ctx.db, ctx.keyring, {
    userId: user.id,
    name: 'test relay',
    type: 'webhook_sms',
    configPublic: { url, template: '{{$.name}}' },
  });
  const event = await createEvent(ctx.db, {
    relayId: relay.id,
    userId: user.id,
    source: 'http',
    status: 'PROCESSING',
    payloadIn: { name: 'Ana' },
  });
  return event;
}

describe('createDeliverProcessor: outcome -> BullMQ translation', () => {
  it('"success" resolves without throwing', async () => {
    const event = await setup(await startDestination(200));
    await expect(
      createDeliverProcessor(testWorker.ctx)(fakeJob(event.id, 0)),
    ).resolves.toBeUndefined();
    expect((await getEventById(testWorker.ctx.db, event.id))?.status).toBe('SUCCESS');
  });

  it('"noop" (already terminal) resolves without throwing', async () => {
    const event = await setup(await startDestination(200));
    await createDeliverProcessor(testWorker.ctx)(fakeJob(event.id, 0)); // first run -> SUCCESS
    await expect(
      createDeliverProcessor(testWorker.ctx)(fakeJob(event.id, 0)),
    ).resolves.toBeUndefined();
  });

  it('"terminal" throws UnrecoverableError', async () => {
    const event = await setup(await startDestination(400));
    await expect(
      createDeliverProcessor(testWorker.ctx)(fakeJob(event.id, 0)),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('"retry" throws a plain Error, not UnrecoverableError', async () => {
    const event = await setup(await startDestination(500));
    const error = await createDeliverProcessor(testWorker.ctx)(fakeJob(event.id, 0)).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
  });

  it('computes attemptNo as job.attemptsMade + 1', async () => {
    const event = await setup(await startDestination(500));
    // attemptsMade=3 -> attemptNo=4 -> the last allowed attempt -> runDeliverJob marks it FAILED.
    await createDeliverProcessor(testWorker.ctx)(fakeJob(event.id, 3)).catch(() => undefined);
    expect((await getEventById(testWorker.ctx.db, event.id))?.status).toBe('FAILED');
  });
});
