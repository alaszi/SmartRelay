import { randomBytes } from 'node:crypto';
import { createSafeHttpClient, Keyring } from '@smartrelay/engine';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, createUser, resetDb } from '../test/helpers';
import type { DbHandle } from './client';
import { createEvent } from './events';
import { creditTopup, getBalance } from './ledger';
import { createRelay, deleteRelay, updateRelay } from './relays';
import {
  createScheduledReminder,
  getReminderById,
  listPendingReminders,
  runReminderJob,
  type ReminderJobDeps,
} from './reminders';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let handle: DbHandle;
let deps: ReminderJobDeps;

beforeAll(() => {
  handle = createTestDb();
  deps = {
    keyring: new Keyring({ id: 'k1', key: randomBytes(32) }),
    http: createSafeHttpClient({
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    }),
  };
});
afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await resetDb(handle.db);
});

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

async function newCalendarBridgeRelay(
  userId: string,
  reminderOverrides: Record<string, unknown> = {
    reminderMode: 'twilio',
    reminderOffsetMinutes: 120,
    reminderRecipientPath: '$.customer.phone',
    reminderTemplate: 'Reminder soon, {{$.customer.name}}',
    reminderAccountSid: 'AC1',
    reminderFrom: '+15551234567',
  },
) {
  return createRelay(handle.db, deps.keyring, {
    userId,
    name: 'calendar relay',
    type: 'calendar_bridge',
    configPublic: {
      titleTemplate: 'Booking: {{$.customer.name}}',
      startPath: '$.booking.start',
      endPath: '$.booking.end',
      ...reminderOverrides,
    },
    configSecret: { refreshToken: 'refresh-1', reminderSecret: 'tok1' },
  });
}

async function newTriggerEvent(relayId: string, userId: string) {
  return createEvent(handle.db, {
    relayId,
    userId,
    source: 'http',
    status: 'SUCCESS',
    payloadIn: { customer: { name: 'Ana', phone: '0722123456' } },
  });
}

describe('runReminderJob: success', () => {
  it('sends the SMS, charges sms_dispatch, and marks the reminder sent', async () => {
    server.use(
      http.post('https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json', () =>
        HttpResponse.json({ sid: 'SM1' }, { status: 201 }),
      ),
    );
    const user = await newUser();
    const relay = await newCalendarBridgeRelay(user.id);
    const event = await newTriggerEvent(relay.id, user.id);
    const reminder = await createScheduledReminder(handle.db, {
      eventId: event.id,
      relayId: relay.id,
      runAt: new Date(),
    });
    const before = await getBalance(handle.db, user.id);

    const outcome = await runReminderJob(handle.db, deps, reminder.id);

    expect(outcome).toEqual({ kind: 'success' });
    expect(await getReminderById(handle.db, reminder.id)).toMatchObject({ status: 'sent' });
    expect(await getBalance(handle.db, user.id)).toBe(before - 25_000n); // sms_dispatch price
  });

  it('is idempotent: replaying an already-sent reminder charges nothing twice', async () => {
    server.use(
      http.post('https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json', () =>
        HttpResponse.json({ sid: 'SM1' }, { status: 201 }),
      ),
    );
    const user = await newUser();
    const relay = await newCalendarBridgeRelay(user.id);
    const event = await newTriggerEvent(relay.id, user.id);
    const reminder = await createScheduledReminder(handle.db, {
      eventId: event.id,
      relayId: relay.id,
      runAt: new Date(),
    });

    await runReminderJob(handle.db, deps, reminder.id);
    const balanceAfterFirst = await getBalance(handle.db, user.id);
    const replay = await runReminderJob(handle.db, deps, reminder.id);

    expect(replay).toEqual({ kind: 'noop' });
    expect(await getBalance(handle.db, user.id)).toBe(balanceAfterFirst);
  });
});

describe('runReminderJob: cancelled without sending or charging', () => {
  it('cancels when the relay was turned inactive since scheduling', async () => {
    const user = await newUser();
    const relay = await newCalendarBridgeRelay(user.id);
    const event = await newTriggerEvent(relay.id, user.id);
    const reminder = await createScheduledReminder(handle.db, {
      eventId: event.id,
      relayId: relay.id,
      runAt: new Date(),
    });
    await updateRelay(handle.db, deps.keyring, user.id, relay.id, { status: 'inactive' });
    const before = await getBalance(handle.db, user.id);

    const outcome = await runReminderJob(handle.db, deps, reminder.id);

    expect(outcome).toEqual({ kind: 'noop' });
    expect(await getReminderById(handle.db, reminder.id)).toMatchObject({ status: 'cancelled' });
    expect(await getBalance(handle.db, user.id)).toBe(before);
  });

  it('cancels when the reminder was turned off since scheduling', async () => {
    const user = await newUser();
    const relay = await newCalendarBridgeRelay(user.id);
    const event = await newTriggerEvent(relay.id, user.id);
    const reminder = await createScheduledReminder(handle.db, {
      eventId: event.id,
      relayId: relay.id,
      runAt: new Date(),
    });
    await updateRelay(handle.db, deps.keyring, user.id, relay.id, {
      configPublic: {
        titleTemplate: 'Booking: {{$.customer.name}}',
        startPath: '$.booking.start',
        endPath: '$.booking.end',
        reminderMode: 'off',
      },
    });

    const outcome = await runReminderJob(handle.db, deps, reminder.id);

    expect(outcome).toEqual({ kind: 'noop' });
    expect(await getReminderById(handle.db, reminder.id)).toMatchObject({ status: 'cancelled' });
  });

  it('is a noop when the relay was deleted (cascades the reminder row away)', async () => {
    const user = await newUser();
    const relay = await newCalendarBridgeRelay(user.id);
    const event = await newTriggerEvent(relay.id, user.id);
    const reminder = await createScheduledReminder(handle.db, {
      eventId: event.id,
      relayId: relay.id,
      runAt: new Date(),
    });
    await deleteRelay(handle.db, user.id, relay.id);

    const outcome = await runReminderJob(handle.db, deps, reminder.id);

    expect(outcome).toEqual({ kind: 'noop' });
  });
});

describe('runReminderJob: insufficient balance', () => {
  it('fails without sending or charging when the balance is too low', async () => {
    const user = await newUser(0n);
    const relay = await newCalendarBridgeRelay(user.id);
    const event = await newTriggerEvent(relay.id, user.id);
    const reminder = await createScheduledReminder(handle.db, {
      eventId: event.id,
      relayId: relay.id,
      runAt: new Date(),
    });

    const outcome = await runReminderJob(handle.db, deps, reminder.id);

    expect(outcome).toMatchObject({ kind: 'terminal', errorCode: 'INSUFFICIENT_BALANCE' });
    expect(await getReminderById(handle.db, reminder.id)).toMatchObject({ status: 'failed' });
    expect(await getBalance(handle.db, user.id)).toBe(0n);
  });
});

describe('runReminderJob: provider failures', () => {
  it('marks failed on a terminal provider error, without charging', async () => {
    server.use(
      http.post('https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json', () =>
        HttpResponse.json({ message: 'bad number' }, { status: 400 }),
      ),
    );
    const user = await newUser();
    const relay = await newCalendarBridgeRelay(user.id);
    const event = await newTriggerEvent(relay.id, user.id);
    const reminder = await createScheduledReminder(handle.db, {
      eventId: event.id,
      relayId: relay.id,
      runAt: new Date(),
    });
    const before = await getBalance(handle.db, user.id);

    const outcome = await runReminderJob(handle.db, deps, reminder.id);

    expect(outcome.kind).toBe('terminal');
    expect(await getReminderById(handle.db, reminder.id)).toMatchObject({ status: 'failed' });
    expect(await getBalance(handle.db, user.id)).toBe(before);
  });

  it('reports retry and leaves the reminder pending on a retryable provider error', async () => {
    server.use(
      http.post('https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json', () =>
        HttpResponse.json({ message: 'down' }, { status: 503 }),
      ),
    );
    const user = await newUser();
    const relay = await newCalendarBridgeRelay(user.id);
    const event = await newTriggerEvent(relay.id, user.id);
    const reminder = await createScheduledReminder(handle.db, {
      eventId: event.id,
      relayId: relay.id,
      runAt: new Date(),
    });

    const outcome = await runReminderJob(handle.db, deps, reminder.id);

    expect(outcome.kind).toBe('retry');
    expect(await getReminderById(handle.db, reminder.id)).toMatchObject({ status: 'pending' });
  });
});

describe('listPendingReminders', () => {
  it('returns only pending reminders, across relays and users', async () => {
    server.use(
      http.post('https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json', () =>
        HttpResponse.json({ sid: 'SM1' }, { status: 201 }),
      ),
    );
    const userA = await newUser();
    const userB = await newUser();
    const relayA = await newCalendarBridgeRelay(userA.id);
    const relayB = await newCalendarBridgeRelay(userB.id);
    const eventA = await newTriggerEvent(relayA.id, userA.id);
    const eventB = await newTriggerEvent(relayB.id, userB.id);
    const pending = await createScheduledReminder(handle.db, {
      eventId: eventA.id,
      relayId: relayA.id,
      runAt: new Date(),
    });
    const willBeSent = await createScheduledReminder(handle.db, {
      eventId: eventB.id,
      relayId: relayB.id,
      runAt: new Date(),
    });
    await runReminderJob(handle.db, deps, willBeSent.id);

    const pendingList = await listPendingReminders(handle.db);

    expect(pendingList.map((r) => r.id)).toEqual([pending.id]);
  });
});
