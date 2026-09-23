import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import { AuthError, LedgerError, RelayError } from '@smartrelay/db';
import Fastify, { type FastifyError, type FastifyInstance, type RawServerDefault } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import type { AppContext } from './context';
import { requireSameOrigin } from './csrf';
import { HttpError } from './http-error';
import { createLogger } from './logger';
import { registerAuthRoutes } from './routes/auth';
import { registerBillingRoutes } from './routes/billing';
import { registerHealthRoutes } from './routes/health';
import { registerInboundEmailRoutes } from './routes/inbound-email';
import { registerIngestRoutes } from './routes/ingest';
import { registerLogsRoutes } from './routes/logs';
import { registerGoogleOAuthRoutes } from './routes/oauth-google';
import { registerRelayRoutes } from './routes/relays';
import { registerTelegramCallbackRoutes } from './routes/telegram-callback';

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}

/** Fastify instance typed with the Zod type provider, for route modules to use in signatures. */
export type App = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  Logger,
  ZodTypeProvider
>;

// Known domain error codes from packages/db, mapped to HTTP status.
const DOMAIN_ERROR_STATUS: Record<string, number> = {
  EMAIL_TAKEN: 409,
  TOKEN_INVALID: 400,
  TOKEN_EXPIRED: 400,
  LIMIT_REACHED: 409,
  NOT_FOUND: 404,
  INVALID_AMOUNT: 400,
  IDEMPOTENCY_CONFLICT: 409,
  EVENT_NOT_FOUND: 404,
  EVENT_NOT_CHARGEABLE: 409,
};

export function buildApp(ctx: AppContext): App {
  const app: App = Fastify({
    loggerInstance: createLogger(ctx.env.NODE_ENV),
    // Trust exactly one hop, not `ctx.env.TRUST_CLOUDFLARE` as a blanket boolean: Nginx
    // (deploy/nginx.smartrelay.conf) is always the sole, immediate reverse proxy in front of this
    // process in the only supported topology (docker-compose.prod.yml), so its X-Forwarded-For
    // entry is the real client IP regardless of whether Cloudflare additionally fronts Nginx. A
    // boolean `true` here would trust the *whole* header, letting a client spoof its own entry;
    // `false` ignores it entirely, which made every request through Nginx collapse onto Nginx's own
    // container IP for rate-limiting purposes (found via Phase 6 load testing) — a sitewide
    // rate-limit bucket shared by all users instead of one per client.
    // TODO(verify-docs): TRUST_CLOUDFLARE is currently unused for this; MASTER_PLAN section 3 also
    // calls for validating CF-Connecting-IP against Cloudflare's published ranges when Cloudflare is
    // in front, which was never implemented in any phase and isn't added here — that needs Cloudflare's
    // current IP list from https://www.cloudflare.com/ips/ and is a separate, still-open piece of work.
    trustProxy: (_address, hop) => hop === 0,
    bodyLimit: 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorate('ctx', ctx);

  app.register(fastifyCookie);
  // The default errorResponseBuilder throws a real Error with .statusCode = 429, which the error
  // handler below turns into the standard { error: { code, message } } shape.
  app.register(fastifyRateLimit, { max: 300, timeWindow: '1 minute' });

  const secureCookies = ctx.env.NODE_ENV === 'production';
  const sameOrigin = requireSameOrigin(ctx.env.APP_URL);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof HttpError) {
      reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.fields ? { fields: error.fields } : {}),
        },
      });
      return;
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      const fields: Record<string, string> = {};
      for (const issue of error.validation) {
        const key = issue.instancePath.replace(/^\//, '').replace(/\//g, '.') || '(root)';
        fields[key] = issue.message ?? 'Invalid value';
      }
      reply
        .status(400)
        .send({ error: { code: 'VALIDATION_ERROR', message: 'Invalid request', fields } });
      return;
    }

    if (error instanceof AuthError || error instanceof RelayError || error instanceof LedgerError) {
      const status = DOMAIN_ERROR_STATUS[error.code] ?? 400;
      reply.status(status).send({ error: { code: error.code, message: error.message } });
      return;
    }

    if (error.statusCode === 429) {
      reply.status(429).send({ error: { code: 'RATE_LIMITED', message: error.message } });
      return;
    }

    if (error.statusCode === 413) {
      reply.status(413).send({ error: { code: 'BODY_TOO_LARGE', message: error.message } });
      return;
    }

    if (error.statusCode === 415) {
      reply
        .status(415)
        .send({ error: { code: 'UNSUPPORTED_CONTENT_TYPE', message: error.message } });
      return;
    }

    if (typeof error.statusCode === 'number' && error.statusCode < 500) {
      reply.status(error.statusCode).send({
        error: { code: 'VALIDATION_ERROR', message: error.message },
      });
      return;
    }

    request.log.error({ err: error }, 'unhandled error');
    reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  // Routes are registered through app.register() (not called directly) so avvio's boot queue
  // loads them strictly after fastifyRateLimit above: otherwise its onRoute hook, which is what
  // applies each route's `config.rateLimit` override, would not exist yet when routes are added.
  app.register(async (instance: App) => {
    registerHealthRoutes(instance);
    registerAuthRoutes(instance, ctx, { secureCookies, sameOrigin });
    registerRelayRoutes(instance, ctx, { sameOrigin });
    registerBillingRoutes(instance, ctx, { sameOrigin });
    registerLogsRoutes(instance, ctx);
    registerGoogleOAuthRoutes(instance, ctx, { sameOrigin });
    registerIngestRoutes(instance, ctx);
    registerInboundEmailRoutes(instance, ctx);
    registerTelegramCallbackRoutes(instance, ctx);
  });

  return app;
}
