import { calendarBridgeConfigSchema, sendReminderSms, type Keyring } from '@smartrelay/engine';
import type { SafeHttpClient } from '@smartrelay/engine';
import { eq } from 'drizzle-orm';
import type { Db, Executor } from './client';
import type { DeliverOutcome } from './deliver';
import { getEventById, getEventPayloadIn } from './events';
import { applyLedgerEntry, getBalance } from './ledger';
import { getPriceMicro } from './pricing';
import { decryptRelaySecret, getRelayInternal } from './relays';
import { scheduledReminders } from './schema';

export type ScheduledReminderRow = typeof scheduledReminders.$inferSelect;

/** MASTER_PLAN section 6: "stored in scheduled_reminders". Called from
 * `runDeliverJob`'s success path (packages/db/src/deliver.ts) when the relay is a `calendar_bridge`
 * with an enabled reminder and the computed `runAt` is still in the future. */
export async function createScheduledReminder(
  db: Executor,
  input: { eventId: string; relayId: string; runAt: Date },
): Promise<ScheduledReminderRow> {
  const [row] = await db
    .insert(scheduledReminders)
    .values({ eventId: input.eventId, relayId: input.relayId, runAt: input.runAt })
    .returning();
  if (!row) throw new Error('scheduled_reminders insert returned no row');
  return row;
}

export async function getReminderById(
  db: Executor,
  id: string,
): Promise<ScheduledReminderRow | undefined> {
  const [row] = await db.select().from(scheduledReminders).where(eq(scheduledReminders.id, id));
  return row;
}

/** Durability (MASTER_PLAN section 6 & 13): every reminder still `pending`, regardless of `runAt`
 * (a past `runAt` just means the caller's delayed job fires immediately) — read on worker start so
 * a Redis loss doesn't silently drop reminders the way it would if only BullMQ remembered them. */
export async function listPendingReminders(db: Executor): Promise<ScheduledReminderRow[]> {
  return db.select().from(scheduledReminders).where(eq(scheduledReminders.status, 'pending'));
}

async function setReminderStatus(
  db: Executor,
  id: string,
  status: 'sent' | 'failed' | 'cancelled',
): Promise<void> {
  await db.update(scheduledReminders).set({ status }).where(eq(scheduledReminders.id, id));
}

export interface ReminderJobDeps {
  keyring: Keyring;
  http: SafeHttpClient;
}

/**
 * Runs one reminder send (MASTER_PLAN section 6: "Reminder = billed as sms_dispatch"). Mirrors
 * `runDeliverJob`'s shape (same `DeliverOutcome`, same queue-agnostic "return, don't throw"
 * contract) but isn't a relay-module dispatch: it loads the *original* triggering event's payload
 * (for the recipient phone and template variables), the relay's current config (which may have
 * changed or been disabled since the reminder was scheduled — re-checked fresh every time, not
 * trusted from scheduling time), sends via the configured SMS provider, and on success charges
 * `sms_dispatch` directly against the ledger (there is no `events` row for a reminder itself, so
 * this doesn't go through `chargeEvent`).
 *
 * Insufficient balance at send time fails the reminder outright (no charge, no send, no retry) —
 * deliberately simpler than the primary pipeline's HELD_NO_CREDIT/48h-hold/auto-release machinery,
 * since section 6 doesn't specify hold semantics for reminders and replicating that machinery for
 * a secondary, already-optional feature is its own separate scope.
 */
export async function runReminderJob(
  db: Db,
  deps: ReminderJobDeps,
  reminderId: string,
): Promise<DeliverOutcome> {
  const reminder = await getReminderById(db, reminderId);
  if (!reminder || reminder.status !== 'pending') return { kind: 'noop' };

  const relay = await getRelayInternal(db, reminder.relayId);
  if (!relay || relay.status !== 'active') {
    await setReminderStatus(db, reminderId, 'cancelled');
    return { kind: 'noop' };
  }

  const mergedConfig = { ...relay.configPublic, ...decryptRelaySecret(deps.keyring, relay) };
  const parsed = calendarBridgeConfigSchema.safeParse(mergedConfig);
  if (!parsed.success || parsed.data.reminderMode === 'off') {
    // The relay was reconfigured (reminder turned off, or its config no longer validates) since
    // this reminder was scheduled — nothing to send.
    await setReminderStatus(db, reminderId, 'cancelled');
    return { kind: 'noop' };
  }
  const config = parsed.data;

  const originalEvent = await getEventById(db, reminder.eventId);
  if (!originalEvent) {
    await setReminderStatus(db, reminderId, 'cancelled');
    return { kind: 'noop' };
  }
  const payload = await getEventPayloadIn(db, reminder.eventId);

  const priceMicro = await getPriceMicro(db, 'sms_dispatch');
  const balance = await getBalance(db, originalEvent.userId);
  if (balance < priceMicro) {
    await setReminderStatus(db, reminderId, 'failed');
    return {
      kind: 'terminal',
      errorCode: 'INSUFFICIENT_BALANCE',
      message: 'balance too low to send the reminder',
    };
  }

  const result = await sendReminderSms(config, payload, deps.http);

  if (result.ok) {
    await db.transaction(async (tx) => {
      await applyLedgerEntry(tx, {
        userId: originalEvent.userId,
        deltaMicro: -priceMicro,
        kind: 'charge',
        refType: 'reminder',
        refId: reminderId,
        idempotencyKey: `reminder-charge:${reminderId}`,
      });
      await setReminderStatus(tx, reminderId, 'sent');
    });
    return { kind: 'success' };
  }

  if (!result.retryable) {
    await setReminderStatus(db, reminderId, 'failed');
    return { kind: 'terminal', errorCode: result.errorCode, message: result.message };
  }
  return { kind: 'retry', errorCode: result.errorCode, message: result.message };
}
