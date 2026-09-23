import {
  getOAuthConnectionForUser,
  getRelayForUser,
  getRelayInternal,
  listOAuthConnectionsForUser,
  decryptOAuthRefreshToken,
  updateRelay,
  upsertOAuthConnection,
} from '@smartrelay/db';
import {
  buildGoogleAuthorizeUrl,
  exchangeGoogleAuthCode,
  fetchGoogleUserEmail,
  GOOGLE_OAUTH_SCOPES,
} from '@smartrelay/engine';
import type { preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { App } from '../app';
import type { AppContext } from '../context';
import { HttpError } from '../http-error';
import { requireAuth } from '../session';

const OAUTH_STATE_AAD = 'oauth-google-state';
const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;

interface OAuthState {
  userId: string;
  relayId: string | null;
  issuedAt: number;
}

const startQuerySchema = z.object({ relayId: z.uuid().optional() });
const callbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
});
const attachBodySchema = z.object({ connectionId: z.uuid() });
const idParamsSchema = z.object({ id: z.uuid() });

function callbackRedirectUri(ctx: AppContext): string {
  return `${ctx.env.APP_URL}/api/oauth/google/callback`;
}

/**
 * `GET /api/oauth/google/start` / `/callback` (MASTER_PLAN section 9 & 10: Module 4's "Google
 * connection" is a required field, not Advanced). Only ever requests the `calendar.events` scope
 * plus `userinfo.email` for display (least privilege, section 8.7). A connection is account-level
 * (`oauth_connections`, reusable across relays); attaching one to a specific relay always copies
 * its refresh token into that relay's own `config_secret` (see packages/db/src/relays.ts's
 * updateRelay), never a live reference, so the module adapter stays a pure per-relay-config
 * function with no extra DB lookup in the delivery pipeline.
 */
export function registerGoogleOAuthRoutes(
  app: App,
  ctx: AppContext,
  options: { sameOrigin: preHandlerHookHandler },
): void {
  const { sameOrigin } = options;
  const auth = requireAuth(ctx);

  app.get('/api/oauth/google/connections', { preHandler: auth }, async (request) => {
    const connections = await listOAuthConnectionsForUser(ctx.db, request.authUser!.id, 'google');
    return {
      connections: connections.map((c) => ({
        id: c.id,
        accountEmail: c.accountEmail,
        createdAt: c.createdAt,
      })),
    };
  });

  app.get(
    '/api/oauth/google/start',
    { preHandler: [auth, sameOrigin], schema: { querystring: startQuerySchema } },
    async (request, reply) => {
      if (!ctx.google) {
        throw new HttpError(503, 'INTERNAL_ERROR', 'Google Calendar is not configured');
      }
      const state: OAuthState = {
        userId: request.authUser!.id,
        relayId: request.query.relayId ?? null,
        issuedAt: Date.now(),
      };
      const url = buildGoogleAuthorizeUrl({
        clientId: ctx.google.clientId,
        redirectUri: callbackRedirectUri(ctx),
        state: ctx.keyring.encrypt(JSON.stringify(state), OAUTH_STATE_AAD),
      });
      reply.redirect(url);
    },
  );

  app.get(
    '/api/oauth/google/callback',
    { preHandler: auth, schema: { querystring: callbackQuerySchema } },
    async (request, reply) => {
      const toDashboard = (googleError: string) => {
        reply.redirect(
          `${ctx.env.APP_URL}/dashboard?googleError=${encodeURIComponent(googleError)}`,
        );
      };
      const { code, state, error } = request.query;

      if (error) return toDashboard(error);
      if (!code || !state || !ctx.google) return toDashboard('invalid_request');

      let parsedState: OAuthState;
      try {
        parsedState = JSON.parse(ctx.keyring.decrypt(state, OAUTH_STATE_AAD)) as OAuthState;
      } catch {
        return toDashboard('invalid_state');
      }
      if (
        parsedState.userId !== request.authUser!.id ||
        Date.now() - parsedState.issuedAt > OAUTH_STATE_MAX_AGE_MS
      ) {
        return toDashboard('invalid_state');
      }

      const exchange = await exchangeGoogleAuthCode({
        clientId: ctx.google.clientId,
        clientSecret: ctx.google.clientSecret,
        code,
        redirectUri: callbackRedirectUri(ctx),
        http: ctx.http,
      });
      if (!exchange.ok) return toDashboard(exchange.message);

      const userInfo = await fetchGoogleUserEmail({
        accessToken: exchange.accessToken,
        http: ctx.http,
      });
      if (!userInfo.ok) return toDashboard(userInfo.message);

      const connection = await upsertOAuthConnection(ctx.db, ctx.keyring, {
        userId: parsedState.userId,
        provider: 'google',
        accountEmail: userInfo.email,
        refreshToken: exchange.refreshToken,
        scopes: GOOGLE_OAUTH_SCOPES,
      });

      if (parsedState.relayId) {
        const relay = await getRelayInternal(ctx.db, parsedState.relayId);
        if (relay && relay.userId === parsedState.userId && relay.type === 'calendar_bridge') {
          await updateRelay(ctx.db, ctx.keyring, parsedState.userId, parsedState.relayId, {
            configSecret: { refreshToken: exchange.refreshToken },
          });
          reply.redirect(
            `${ctx.env.APP_URL}/relays/${parsedState.relayId}?connected=${encodeURIComponent(connection.accountEmail)}`,
          );
          return;
        }
      }
      reply.redirect(
        `${ctx.env.APP_URL}/dashboard?connected=${encodeURIComponent(connection.accountEmail)}`,
      );
    },
  );

  // Attaches an already-connected Google account to a relay without repeating the OAuth dance
  // (e.g. reusing one connection across several calendar_bridge relays).
  app.post(
    '/api/relays/:id/google-connection',
    {
      preHandler: [auth, sameOrigin],
      schema: { params: idParamsSchema, body: attachBodySchema },
    },
    async (request) => {
      const relay = await getRelayForUser(ctx.db, request.authUser!.id, request.params.id);
      if (!relay || relay.type !== 'calendar_bridge') {
        throw new HttpError(404, 'RELAY_NOT_FOUND', 'Relay not found');
      }
      const connection = await getOAuthConnectionForUser(
        ctx.db,
        request.authUser!.id,
        request.body.connectionId,
      );
      if (!connection) {
        throw new HttpError(404, 'NOT_FOUND', 'Google connection not found');
      }

      await updateRelay(ctx.db, ctx.keyring, request.authUser!.id, relay.id, {
        configSecret: { refreshToken: decryptOAuthRefreshToken(ctx.keyring, connection) },
      });
      return { accountEmail: connection.accountEmail };
    },
  );
}
