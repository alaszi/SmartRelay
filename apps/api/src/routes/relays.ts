import {
  createEvent,
  createRelay,
  decryptRelaySecret,
  deleteRelay,
  getEventById,
  getRelayEmailAddress,
  getRelayForUser,
  getRelayInternal,
  listRelaysForUser,
  runDeliverJob,
  rotateIngestToken,
  updateRelay,
  type RelayPublicRow,
} from '@smartrelay/db';
import {
  createRelayInputSchema,
  DELIVER_MAX_ATTEMPTS,
  formatMicroEur,
  updateRelayInputSchema,
  type RelayType,
} from '@smartrelay/shared';
import type { preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { App } from '../app';
import type { AppContext } from '../context';
import { HttpError } from '../http-error';
import { requireAuth } from '../session';

const idParamsSchema = z.object({ id: z.uuid() });

/**
 * Validates a relay's merged config against its module's own schema (MASTER_PLAN section 6):
 * `configPublic`/`configSecret` are just generic records at the HTTP-body level, so without this
 * a relay could be saved with a config the adapter will only reject later, at ingest time.
 */
function assertValidModuleConfig(
  ctx: AppContext,
  type: RelayType,
  configPublic: Record<string, unknown>,
  configSecret: Record<string, unknown> | undefined,
): void {
  const relayModule = ctx.modules[type];
  if (!relayModule) return; // MODULE_NOT_IMPLEMENTED is reported at ingest time, not here.
  const parsed = relayModule.configSchema.safeParse({ ...configPublic, ...configSecret });
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fields[issue.path.join('.') || '(root)'] = issue.message;
    }
    throw new HttpError(400, 'VALIDATION_ERROR', 'Relay configuration is invalid', fields);
  }
}

/** The web wizard's step 2 ("input") needs the auto-generated inbound address for email_api
 * relays, same as it needs `ingestToken` for the other three types — both are trigger info. */
async function withEmailAddress(
  ctx: AppContext,
  relay: RelayPublicRow,
): Promise<RelayPublicRow & { emailAddress?: string }> {
  if (relay.type !== 'email_api') return relay;
  const emailAddress = await getRelayEmailAddress(ctx.db, relay.id);
  return emailAddress ? { ...relay, emailAddress } : relay;
}

export function registerRelayRoutes(
  app: App,
  ctx: AppContext,
  options: { sameOrigin: preHandlerHookHandler },
): void {
  const { sameOrigin } = options;
  const auth = requireAuth(ctx);

  app.get('/api/relays', { preHandler: auth }, async (request) => {
    const relays = await listRelaysForUser(ctx.db, request.authUser!.id);
    return { relays };
  });

  app.post(
    '/api/relays',
    { preHandler: [auth, sameOrigin], schema: { body: createRelayInputSchema } },
    async (request, reply) => {
      const user = request.authUser!;
      if (user.emailVerifiedAt === null) {
        throw new HttpError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email before creating a relay');
      }
      // The web wizard creates a relay right after step 1 (name + type only, no config yet) and
      // fills in the destination later via PATCH, so an omitted config is not validated here —
      // only one the caller actually supplied.
      if (request.body.configPublic !== undefined || request.body.configSecret !== undefined) {
        assertValidModuleConfig(
          ctx,
          request.body.type,
          request.body.configPublic ?? {},
          request.body.configSecret,
        );
      }
      const relay = await createRelay(ctx.db, ctx.keyring, {
        userId: user.id,
        ...request.body,
        inboundDomain: ctx.env.INBOUND_DOMAIN,
      });
      reply.status(201);
      return { relay: await withEmailAddress(ctx, relay) };
    },
  );

  app.get(
    '/api/relays/:id',
    { preHandler: auth, schema: { params: idParamsSchema } },
    async (request) => {
      const relay = await getRelayForUser(ctx.db, request.authUser!.id, request.params.id);
      if (!relay) throw new HttpError(404, 'RELAY_NOT_FOUND', 'Relay not found');
      return { relay: await withEmailAddress(ctx, relay) };
    },
  );

  app.patch(
    '/api/relays/:id',
    {
      preHandler: [auth, sameOrigin],
      schema: { params: idParamsSchema, body: updateRelayInputSchema },
    },
    async (request) => {
      if (request.body.configPublic !== undefined || request.body.configSecret !== undefined) {
        const existing = await getRelayInternal(ctx.db, request.params.id);
        if (!existing || existing.userId !== request.authUser!.id) {
          throw new HttpError(404, 'RELAY_NOT_FOUND', 'Relay not found');
        }
        // Merge onto the existing secret the same way updateRelay() actually will, not
        // request.body.configSecret alone: a "Replace" only ever sends the one field being
        // changed (secrets are write-only), so validating just that field was previously correct
        // only by accident, for modules with exactly one secret field always resent whole. Module
        // 4's reminder adds a second, independently-updatable one (refreshToken vs reminderSecret).
        const existingSecret = decryptRelaySecret(ctx.keyring, existing);
        assertValidModuleConfig(
          ctx,
          existing.type,
          request.body.configPublic ?? existing.configPublic,
          request.body.configSecret
            ? { ...existingSecret, ...request.body.configSecret }
            : existingSecret,
        );
      }
      const relay = await updateRelay(
        ctx.db,
        ctx.keyring,
        request.authUser!.id,
        request.params.id,
        request.body,
      );
      return { relay: await withEmailAddress(ctx, relay) };
    },
  );

  app.delete(
    '/api/relays/:id',
    { preHandler: [auth, sameOrigin], schema: { params: idParamsSchema } },
    async (request, reply) => {
      await deleteRelay(ctx.db, request.authUser!.id, request.params.id);
      reply.status(204);
    },
  );

  app.post(
    '/api/relays/:id/rotate-token',
    { preHandler: [auth, sameOrigin], schema: { params: idParamsSchema } },
    async (request) => {
      const relay = await rotateIngestToken(ctx.db, request.authUser!.id, request.params.id);
      return { relay };
    },
  );

  app.post(
    '/api/relays/:id/test',
    {
      preHandler: [auth, sameOrigin],
      schema: { params: idParamsSchema, body: z.object({ payload: z.unknown() }) },
    },
    async (request) => {
      const relay = await getRelayForUser(ctx.db, request.authUser!.id, request.params.id);
      if (!relay) throw new HttpError(404, 'RELAY_NOT_FOUND', 'Relay not found');

      const event = await createEvent(ctx.db, {
        relayId: relay.id,
        userId: relay.userId,
        source: 'test',
        status: 'RECEIVED',
        payloadIn: request.body.payload,
      });

      // Real delivery, billed normally, source=test in logs (MASTER_PLAN decision D9). Run
      // synchronously rather than through the deliver queue: the UI needs the result immediately.
      const outcome = await runDeliverJob(
        ctx.db,
        {
          keyring: ctx.keyring,
          modules: ctx.modules,
          http: ctx.http,
          ...(ctx.google ? { google: ctx.google } : {}),
        },
        { eventId: event.id, attemptNo: 1 },
      );

      // A test send is a real, billed delivery (decision D9 above), so it can schedule a real
      // reminder too (Module 4's Advanced "SMS reminder") — mirrors apps/worker/src/deliver.ts's
      // own enqueue step for the same DeliverOutcome shape.
      if (outcome.kind === 'success' && outcome.scheduledReminder) {
        const { reminderId, runAt } = outcome.scheduledReminder;
        await ctx.reminderQueue.add(
          'reminder',
          { reminderId },
          {
            jobId: reminderId,
            delay: Math.max(0, runAt.getTime() - Date.now()),
            attempts: DELIVER_MAX_ATTEMPTS,
            backoff: { type: 'custom' },
          },
        );
      }

      const finished = await getEventById(ctx.db, event.id);
      return {
        outcome,
        event: finished && {
          id: finished.id,
          status: finished.status,
          errorCode: finished.errorCode,
          finalStatusCode: finished.finalStatusCode,
          cost: formatMicroEur(finished.costMicro),
        },
      };
    },
  );
}
