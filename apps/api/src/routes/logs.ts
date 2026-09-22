import {
  getEventById,
  getEventPayloadRow,
  listDeliveryAttempts,
  listEventsForUser,
} from '@smartrelay/db';
import { eventStatusSchema, formatMicroEur } from '@smartrelay/shared';
import { z } from 'zod';
import type { App } from '../app';
import type { AppContext } from '../context';
import { HttpError } from '../http-error';
import { requireAuth } from '../session';

const listQuerySchema = z.object({
  relayId: z.uuid().optional(),
  status: eventStatusSchema.optional(),
  cursor: z.iso.datetime({ offset: true }).optional(),
});

const eventParamsSchema = z.object({ eventId: z.uuid() });

export function registerLogsRoutes(app: App, ctx: AppContext): void {
  const auth = requireAuth(ctx);

  app.get(
    '/api/logs',
    { preHandler: auth, schema: { querystring: listQuerySchema } },
    async (request) => {
      const { events, nextCursor } = await listEventsForUser(ctx.db, request.authUser!.id, {
        ...(request.query.relayId ? { relayId: request.query.relayId } : {}),
        ...(request.query.status ? { status: request.query.status } : {}),
        ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
      });
      return {
        events: events.map((event) => ({
          id: event.id,
          relayId: event.relayId,
          relayName: event.relayName,
          source: event.source,
          status: event.status,
          cost: formatMicroEur(event.costMicro),
          errorCode: event.errorCode,
          finalStatusCode: event.finalStatusCode,
          receivedAt: event.receivedAt,
        })),
        nextCursor,
      };
    },
  );

  app.get(
    '/api/logs/:eventId',
    { preHandler: auth, schema: { params: eventParamsSchema } },
    async (request) => {
      const event = await getEventById(ctx.db, request.params.eventId);
      if (!event || event.userId !== request.authUser!.id) {
        throw new HttpError(404, 'EVENT_NOT_FOUND', 'Event not found');
      }
      const [payload, attempts] = await Promise.all([
        getEventPayloadRow(ctx.db, event.id),
        listDeliveryAttempts(ctx.db, event.id),
      ]);

      return {
        event: {
          id: event.id,
          relayId: event.relayId,
          source: event.source,
          status: event.status,
          cost: formatMicroEur(event.costMicro),
          errorCode: event.errorCode,
          finalStatusCode: event.finalStatusCode,
          receivedAt: event.receivedAt,
          finishedAt: event.finishedAt,
        },
        payload: payload
          ? {
              in: payload.payloadIn,
              out: payload.payloadOut,
              responseExcerpt: payload.responseExcerpt,
            }
          : null, // purged past its 30-day retention (MASTER_PLAN section 7)
        attempts: attempts.map((a) => ({
          attemptNo: a.attemptNo,
          ok: a.ok,
          statusCode: a.statusCode,
          errorCode: a.errorCode,
          errorMessage: a.errorMessage,
          durationMs: a.durationMs,
          startedAt: a.startedAt,
        })),
      };
    },
  );
}
