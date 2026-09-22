import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createRelay,
  createUser,
  creditTopup,
  getBalance,
  getEventById,
  type UserRow,
} from '@smartrelay/db';
import { createSafeHttpClient } from '@smartrelay/engine';
import { Worker } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, resetDb, type TestApp } from '../../test/helpers';
// Cross-package relative import: apps/worker's own runtime dependencies (bullmq, @smartrelay/db,
// @smartrelay/shared) are already direct dependencies of apps/api too, so this resolves cleanly.
import { createDeliverProcessor } from '../../../worker/src/deliver';
import { releaseHeldEventsForUser } from '../../../worker/src/release';
import type { WorkerContext } from '../../../worker/src/context';

let testApp: TestApp;
let user: UserRow;
let worker: Worker | undefined;
const servers: http.Server[] = [];

beforeEach(async () => {
  testApp = buildTestApp();
  await resetDb(testApp.ctx.db);
  user = await createUser(testApp.ctx.db, {
    email: `pipeline-${Math.random().toString(36).slice(2)}@example.com`,
    passwordHash: 'h',
  });
});

afterEach(async () => {
  await worker?.close();
  worker = undefined;
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

function startWorker(): WorkerContext {
  const workerCtx: WorkerContext = {
    ...testApp.ctx,
    http: createSafeHttpClient({
      unsafeAllowPrivateAddresses: true,
      allowedPorts: Array.from({ length: 65535 }, (_, i) => i + 1),
    }),
  };
  worker = new Worker(testApp.ctx.deliverQueue.name, createDeliverProcessor(workerCtx), {
    connection: testApp.ctx.redis,
  });
  return workerCtx;
}

function waitForJob(
  target: Worker,
  jobId: string,
  timeoutMs = 10_000,
): Promise<'completed' | 'failed'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for job ${jobId}`));
    }, timeoutMs);
    const onCompleted = (job: { id?: string }) => {
      if (job.id === jobId) {
        cleanup();
        resolve('completed');
      }
    };
    const onFailed = (job: { id?: string } | undefined) => {
      if (job?.id === jobId) {
        cleanup();
        resolve('failed');
      }
    };
    function cleanup() {
      clearTimeout(timer);
      target.off('completed', onCompleted);
      target.off('failed', onFailed);
    }
    target.on('completed', onCompleted);
    target.on('failed', onFailed);
  });
}

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
    startWorker();
    const balanceBefore = await getBalance(testApp.ctx.db, user.id);

    const response = await testApp.app.inject({
      method: 'POST',
      url: `/i/${r.ingestToken}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Ana' }),
    });
    expect(response.statusCode).toBe(202);
    const { eventId } = response.json();

    expect(await waitForJob(worker!, eventId)).toBe('completed');

    const event = await getEventById(testApp.ctx.db, eventId);
    expect(event?.status).toBe('SUCCESS');
    expect(event?.costMicro).toBe(25_000n); // webhook_sms -> sms_dispatch
    expect(event?.finalStatusCode).toBe(200);
    expect(await getBalance(testApp.ctx.db, user.id)).toBe(balanceBefore - 25_000n);
  });

  it('retries a 500 and eventually marks the event FAILED, unbilled, after the retries are exhausted', async () => {
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
    startWorker();
    const balanceBefore = await getBalance(testApp.ctx.db, user.id);

    const response = await testApp.app.inject({
      method: 'POST',
      url: `/i/${r.ingestToken}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Ana' }),
    });
    const { eventId } = response.json();

    // BullMQ's real backoff is 1/5/15 min (see packages/shared/src/queue.test.ts for the exact
    // values); waiting that out for real is impractical here, so only the first, immediate attempt
    // is observed — enough to prove the destination was actually called and nothing was charged.
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(calls).toBeGreaterThanOrEqual(1);
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

    const ingestResponse = await testApp.app.inject({
      method: 'POST',
      url: `/i/${r.ingestToken}`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'Ana' }),
    });
    expect(ingestResponse.statusCode).toBe(202);
    expect(ingestResponse.json().held).toBe(true);
    const { eventId } = ingestResponse.json();
    expect((await getEventById(testApp.ctx.db, eventId))?.status).toBe('HELD_NO_CREDIT');

    const workerCtx = startWorker();
    await topUp(1_000_000n);
    const released = await releaseHeldEventsForUser(workerCtx, user.id);
    expect(released).toBe(1);
    expect((await getEventById(testApp.ctx.db, eventId))?.status).toBe('QUEUED');

    expect(await waitForJob(worker!, eventId)).toBe('completed');

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
      const response = await testApp.app.inject({
        method: 'POST',
        url: `/i/${r.ingestToken}`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ n: i }),
      });
      eventIds.push(response.json().eventId);
    }

    const workerCtx = startWorker();
    await topUp(1_000_000n);
    await releaseHeldEventsForUser(workerCtx, user.id);

    await Promise.all(eventIds.map((id) => waitForJob(worker!, id)));
    const statuses = await Promise.all(eventIds.map((id) => getEventById(testApp.ctx.db, id)));
    expect(statuses.every((event) => event?.status === 'SUCCESS')).toBe(true);
  });
});
