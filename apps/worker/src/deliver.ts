import {
  chargeEvent,
  decryptRelaySecret,
  getEventById,
  getEventPayloadIn,
  getPriceMicro,
  getRelayInternal,
  markFailed,
  markProcessing,
  recordDeliveryAttempt,
} from '@smartrelay/db';
import { DELIVER_MAX_ATTEMPTS, type DeliverJobData } from '@smartrelay/shared';
import { UnrecoverableError, type Job } from 'bullmq';
import type { WorkerContext } from './context';

/**
 * Processes one `deliver` job (MASTER_PLAN section 5, "Worker `deliver`"). Throwing a plain Error
 * lets BullMQ retry with the queue's custom backoff; throwing UnrecoverableError stops retries
 * immediately regardless of attempts remaining (terminal failures, and failures that are not the
 * module's fault at all — an event/relay/module that no longer exists).
 */
export function createDeliverProcessor(ctx: WorkerContext) {
  return async function processDeliver(job: Job<DeliverJobData>): Promise<void> {
    const attemptNo = job.attemptsMade + 1;
    const { eventId } = job.data;

    const event = await getEventById(ctx.db, eventId);
    if (!event) throw new UnrecoverableError(`event ${eventId} not found`);
    // A replayed/duplicate job for an event already billed is a no-op, not an error.
    if (event.status === 'SUCCESS' || event.status === 'FAILED') return;

    const relay = await getRelayInternal(ctx.db, event.relayId);
    if (!relay) {
      await markFailed(ctx.db, eventId, { errorCode: 'RELAY_NOT_FOUND' });
      throw new UnrecoverableError(`relay ${event.relayId} not found`);
    }

    const relayModule = ctx.modules[relay.type];
    if (!relayModule) {
      await markFailed(ctx.db, eventId, { errorCode: 'MODULE_NOT_IMPLEMENTED' });
      throw new UnrecoverableError(`no module registered for relay type ${relay.type}`);
    }

    const mergedConfig = { ...relay.configPublic, ...decryptRelaySecret(ctx.keyring, relay) };
    const parsedConfig = relayModule.configSchema.safeParse(mergedConfig);
    if (!parsedConfig.success) {
      await markFailed(ctx.db, eventId, { errorCode: 'RELAY_CONFIG_INVALID' });
      throw new UnrecoverableError(`relay ${relay.id} configuration is invalid`);
    }

    await markProcessing(ctx.db, eventId);
    const payload = await getEventPayloadIn(ctx.db, eventId);

    const startedAt = Date.now();
    const result = await relayModule.execute({
      config: parsedConfig.data,
      payload,
      ctx: { eventId, userTimezone: 'Europe/Bucharest', http: ctx.http, now: new Date() },
    });
    const durationMs = Date.now() - startedAt;

    await recordDeliveryAttempt(ctx.db, {
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
      const priceMicro = await getPriceMicro(ctx.db, priceKind);
      await chargeEvent(ctx.db, { eventId, priceMicro, finalStatusCode: result.statusCode });
      return;
    }

    if (!result.retryable) {
      await markFailed(ctx.db, eventId, {
        errorCode: result.errorCode,
        ...(result.statusCode === undefined ? {} : { finalStatusCode: result.statusCode }),
      });
      throw new UnrecoverableError(result.message);
    }

    // Retryable, but this was the last of the allowed attempts: BullMQ will not schedule another
    // one, so the event must be marked FAILED here rather than left stuck in PROCESSING.
    if (attemptNo >= DELIVER_MAX_ATTEMPTS) {
      await markFailed(ctx.db, eventId, {
        errorCode: result.errorCode,
        ...(result.statusCode === undefined ? {} : { finalStatusCode: result.statusCode }),
      });
    }
    throw new Error(result.message);
  };
}
