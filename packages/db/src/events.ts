import { and, asc, eq, gt, isNotNull, lt, sql } from 'drizzle-orm';
import type { EventSource, EventStatus } from '@smartrelay/shared';
import type { Executor } from './client';
import { deliveryAttempts, eventPayloads, events } from './schema';

export type EventRow = typeof events.$inferSelect;
export type DeliveryAttemptRow = typeof deliveryAttempts.$inferSelect;

const PAYLOAD_RETENTION_MS = 30 * 24 * 3600 * 1000;

export interface CreateEventInput {
  relayId: string;
  userId: string;
  source: EventSource;
  status: EventStatus;
  payloadIn?: unknown;
  heldUntil?: Date;
  errorCode?: string;
  dedupeHash?: string;
}

/**
 * Inserts one event, and its payload when given. Terminal statuses (REJECTED, DROPPED_LOOP,
 * FAILED) get `finishedAt` set immediately, since nothing further will happen to them.
 */
export async function createEvent(db: Executor, input: CreateEventInput): Promise<EventRow> {
  const terminal = new Set<EventStatus>(['REJECTED', 'DROPPED_LOOP', 'FAILED']);

  const [event] = await db
    .insert(events)
    .values({
      relayId: input.relayId,
      userId: input.userId,
      source: input.source,
      status: input.status,
      heldUntil: input.heldUntil ?? null,
      errorCode: input.errorCode ?? null,
      dedupeHash: input.dedupeHash ?? null,
      finishedAt: terminal.has(input.status) ? sql`now()` : null,
    })
    .returning();
  if (!event) throw new Error('event insert returned no row');

  if (input.payloadIn !== undefined) {
    await db.insert(eventPayloads).values({
      eventId: event.id,
      payloadIn: input.payloadIn,
      purgeAfter: new Date(Date.now() + PAYLOAD_RETENTION_MS),
    });
  }

  return event;
}

export async function getEventById(db: Executor, id: string): Promise<EventRow | undefined> {
  const [event] = await db.select().from(events).where(eq(events.id, id)).limit(1);
  return event;
}

export async function getEventPayloadIn(db: Executor, eventId: string): Promise<unknown> {
  const [row] = await db
    .select({ payloadIn: eventPayloads.payloadIn })
    .from(eventPayloads)
    .where(eq(eventPayloads.eventId, eventId))
    .limit(1);
  return row?.payloadIn;
}

/** 24 h dedupe per relay for the optional `Idempotency-Key` ingest header. */
export async function findRecentEventByDedupeHash(
  db: Executor,
  relayId: string,
  dedupeHash: string,
): Promise<EventRow | undefined> {
  const [event] = await db
    .select()
    .from(events)
    .where(
      and(
        eq(events.relayId, relayId),
        eq(events.dedupeHash, dedupeHash),
        gt(events.receivedAt, new Date(Date.now() - 24 * 3600 * 1000)),
      ),
    )
    .limit(1);
  return event;
}

export async function markQueued(db: Executor, eventId: string): Promise<void> {
  await db.update(events).set({ status: 'QUEUED' }).where(eq(events.id, eventId));
}

export async function markProcessing(db: Executor, eventId: string): Promise<void> {
  await db.update(events).set({ status: 'PROCESSING' }).where(eq(events.id, eventId));
}

export async function markFailed(
  db: Executor,
  eventId: string,
  input: { errorCode: string; finalStatusCode?: number },
): Promise<void> {
  await db
    .update(events)
    .set({
      status: 'FAILED',
      errorCode: input.errorCode,
      finalStatusCode: input.finalStatusCode ?? null,
      finishedAt: sql`now()`,
    })
    .where(eq(events.id, eventId));
}

export async function recordDeliveryAttempt(
  db: Executor,
  input: {
    eventId: string;
    attemptNo: number;
    ok: boolean;
    durationMs?: number;
    statusCode?: number;
    errorCode?: string;
    errorMessage?: string;
  },
): Promise<DeliveryAttemptRow> {
  const values = {
    eventId: input.eventId,
    attemptNo: input.attemptNo,
    ok: input.ok,
    durationMs: input.durationMs ?? null,
    statusCode: input.statusCode ?? null,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
  };
  // Upsert, not insert-or-ignore: a BullMQ stalled-job recovery can re-run the same attemptNo, and
  // the retried outcome (not the first, abandoned one) is what should be on record.
  const [attempt] = await db
    .insert(deliveryAttempts)
    .values(values)
    .onConflictDoUpdate({
      target: [deliveryAttempts.eventId, deliveryAttempts.attemptNo],
      set: values,
    })
    .returning();
  if (!attempt) throw new Error('delivery attempt insert returned no row');
  return attempt;
}

export async function countDeliveryAttempts(db: Executor, eventId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(deliveryAttempts)
    .where(eq(deliveryAttempts.eventId, eventId));
  return rows[0]?.n ?? 0;
}

/** Oldest-first, for releasing held events into the deliver queue in the order they arrived. */
export async function listHeldEventsForUser(db: Executor, userId: string): Promise<EventRow[]> {
  return db
    .select()
    .from(events)
    .where(and(eq(events.userId, userId), eq(events.status, 'HELD_NO_CREDIT')))
    .orderBy(asc(events.receivedAt));
}

/** Maintenance job: held events past their 48 h deadline expire. Returns how many were expired. */
export async function expireStaleHeldEvents(db: Executor): Promise<EventRow[]> {
  return db
    .update(events)
    .set({ status: 'EXPIRED', finishedAt: sql`now()` })
    .where(
      and(
        eq(events.status, 'HELD_NO_CREDIT'),
        isNotNull(events.heldUntil),
        lt(events.heldUntil, sql`now()`),
      ),
    )
    .returning();
}

/** Maintenance job (GDPR retention, MASTER_PLAN section 7): purges payload content past 30 days. */
export async function purgeExpiredPayloads(db: Executor): Promise<number> {
  const rows = await db
    .delete(eventPayloads)
    .where(lt(eventPayloads.purgeAfter, sql`now()`))
    .returning({ eventId: eventPayloads.eventId });
  return rows.length;
}
