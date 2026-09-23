import type { Keyring, ModuleRegistry, SafeHttpClient } from '@smartrelay/engine';
import { DELIVER_MAX_ATTEMPTS } from '@smartrelay/shared';
import type { Db } from './client';
import {
  getEventById,
  getEventPayloadIn,
  markFailed,
  markProcessing,
  recordDeliveryAttempt,
} from './events';
import { chargeEvent } from './ledger';
import { getPriceMicro } from './pricing';
import { decryptRelaySecret, getRelayInternal } from './relays';
import { createScheduledReminder } from './reminders';

export type DeliverOutcome =
  /** The event was already terminal (SUCCESS/FAILED): a safe no-op, e.g. a replayed job. */
  | { kind: 'noop' }
  | {
      kind: 'success';
      /** Set when the module scheduled a follow-up (Module 4's SMS reminder). The caller (the
       * queue-specific processor) is the one that actually enqueues the delayed job — this
       * function stays queue-agnostic, same as the rest of its contract. */
      scheduledReminder?: { reminderId: string; runAt: Date };
    }
  /** Must not be retried, regardless of attempts remaining. */
  | { kind: 'terminal'; errorCode: string; message: string }
  /** May be retried; the caller decides the backoff/retry mechanics. */
  | { kind: 'retry'; errorCode: string; message: string };

export interface DeliverJobInput {
  eventId: string;
  /** 1-based: the first attempt is 1, matching `delivery_attempts.attempt_no`. */
  attemptNo: number;
}

export interface DeliverDeps {
  keyring: Keyring;
  modules: ModuleRegistry;
  /** The only way the module reaches a user-supplied URL. */
  http: SafeHttpClient;
  /** Module 4 only (Google Calendar); undefined when GOOGLE_CLIENT_ID/SECRET are not configured. */
  google?: { clientId: string; clientSecret: string };
}

/**
 * Runs one delivery attempt for an event (MASTER_PLAN section 5, "Worker `deliver`"): loads the
 * relay, decrypts its config, runs the module adapter, records the attempt, and on success charges
 * the event through the ledger. Deliberately queue-agnostic — it returns an outcome instead of
 * throwing a queue-specific error, so any queue implementation (apps/worker's BullMQ processor
 * today) is the only place that decides how to signal "retry" vs "stop" to its own queue.
 */
export async function runDeliverJob(
  db: Db,
  deps: DeliverDeps,
  input: DeliverJobInput,
): Promise<DeliverOutcome> {
  const { eventId, attemptNo } = input;

  const event = await getEventById(db, eventId);
  if (!event) {
    return {
      kind: 'terminal',
      errorCode: 'EVENT_NOT_FOUND',
      message: `event ${eventId} not found`,
    };
  }
  if (event.status === 'SUCCESS' || event.status === 'FAILED') return { kind: 'noop' };

  const relay = await getRelayInternal(db, event.relayId);
  if (!relay) {
    await markFailed(db, eventId, { errorCode: 'RELAY_NOT_FOUND' });
    return {
      kind: 'terminal',
      errorCode: 'RELAY_NOT_FOUND',
      message: `relay ${event.relayId} not found`,
    };
  }

  const relayModule = deps.modules[relay.type];
  if (!relayModule) {
    await markFailed(db, eventId, { errorCode: 'MODULE_NOT_IMPLEMENTED' });
    return {
      kind: 'terminal',
      errorCode: 'MODULE_NOT_IMPLEMENTED',
      message: `no module registered for relay type ${relay.type}`,
    };
  }

  const mergedConfig = { ...relay.configPublic, ...decryptRelaySecret(deps.keyring, relay) };
  const parsedConfig = relayModule.configSchema.safeParse(mergedConfig);
  if (!parsedConfig.success) {
    await markFailed(db, eventId, { errorCode: 'RELAY_CONFIG_INVALID' });
    return {
      kind: 'terminal',
      errorCode: 'RELAY_CONFIG_INVALID',
      message: `relay ${relay.id} configuration is invalid`,
    };
  }

  await markProcessing(db, eventId);
  const payload = await getEventPayloadIn(db, eventId);

  const startedAt = Date.now();
  const result = await relayModule.execute({
    config: parsedConfig.data,
    payload,
    ctx: {
      eventId,
      userTimezone: 'Europe/Bucharest',
      http: deps.http,
      now: new Date(),
      ...(deps.google ? { google: deps.google } : {}),
    },
  });
  const durationMs = Date.now() - startedAt;

  await recordDeliveryAttempt(db, {
    eventId,
    attemptNo,
    ok: result.ok,
    durationMs,
    ...(result.statusCode === undefined ? {} : { statusCode: result.statusCode }),
    ...(result.ok
      ? {}
      : { errorCode: result.errorCode, errorMessage: result.message.slice(0, 2000) }),
  });

  if (result.ok) {
    const priceKind = relayModule.priceKind(parsedConfig.data);
    const priceMicro = await getPriceMicro(db, priceKind);
    await chargeEvent(db, { eventId, priceMicro, finalStatusCode: result.statusCode });

    const followUp = relayModule.scheduleFollowUp?.({ config: parsedConfig.data, result });
    if (!followUp) return { kind: 'success' };
    const reminder = await createScheduledReminder(db, {
      eventId,
      relayId: relay.id,
      runAt: followUp.runAt,
    });
    return {
      kind: 'success',
      scheduledReminder: { reminderId: reminder.id, runAt: followUp.runAt },
    };
  }

  if (!result.retryable) {
    await markFailed(db, eventId, {
      errorCode: result.errorCode,
      ...(result.statusCode === undefined ? {} : { finalStatusCode: result.statusCode }),
    });
    return { kind: 'terminal', errorCode: result.errorCode, message: result.message };
  }

  // Retryable, but this was the last of the allowed attempts: the caller's queue will not schedule
  // another one, so the event must be marked FAILED here rather than left stuck in PROCESSING.
  if (attemptNo >= DELIVER_MAX_ATTEMPTS) {
    await markFailed(db, eventId, {
      errorCode: result.errorCode,
      ...(result.statusCode === undefined ? {} : { finalStatusCode: result.statusCode }),
    });
  }
  return { kind: 'retry', errorCode: result.errorCode, message: result.message };
}
