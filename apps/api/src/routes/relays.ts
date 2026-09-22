import {
  createRelay,
  deleteRelay,
  getRelayForUser,
  listRelaysForUser,
  rotateIngestToken,
  updateRelay,
} from '@smartrelay/db';
import { createRelayInputSchema, updateRelayInputSchema } from '@smartrelay/shared';
import type { preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { App } from '../app';
import type { AppContext } from '../context';
import { HttpError } from '../http-error';
import { requireAuth } from '../session';

const idParamsSchema = z.object({ id: z.uuid() });

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
      const relay = await createRelay(ctx.db, ctx.keyring, {
        userId: user.id,
        ...request.body,
        inboundDomain: ctx.env.INBOUND_DOMAIN,
      });
      reply.status(201);
      return { relay };
    },
  );

  app.get(
    '/api/relays/:id',
    { preHandler: auth, schema: { params: idParamsSchema } },
    async (request) => {
      const relay = await getRelayForUser(ctx.db, request.authUser!.id, request.params.id);
      if (!relay) throw new HttpError(404, 'RELAY_NOT_FOUND', 'Relay not found');
      return { relay };
    },
  );

  app.patch(
    '/api/relays/:id',
    {
      preHandler: [auth, sameOrigin],
      schema: { params: idParamsSchema, body: updateRelayInputSchema },
    },
    async (request) => {
      const relay = await updateRelay(
        ctx.db,
        ctx.keyring,
        request.authUser!.id,
        request.params.id,
        request.body,
      );
      return { relay };
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
}
