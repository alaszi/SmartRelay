import { createHash } from 'node:crypto';
import {
  createEvent,
  decryptRelaySecret,
  findRecentEventByDedupeHash,
  findRelayByIngestToken,
  findUserById,
  getBalance,
  getPriceMicro,
  markQueued,
  touchLastTriggered,
  tryRecordNotification,
} from '@smartrelay/db';
import { verifyHmac, type HmacAlgorithm, type HmacEncoding } from '@smartrelay/engine';
import {
  DELIVER_MAX_ATTEMPTS,
  HELD_EVENT_TTL_MS,
  LIMITS,
  LOOP_GUARD_THRESHOLD,
  LOOP_GUARD_WINDOW_S,
} from '@smartrelay/shared';
import { z } from 'zod';
import type { App } from '../app';
import type { AppContext } from '../context';

const paramsSchema = z.object({ ingestToken: z.string().min(1) });

const hmacSettingsSchema = z.object({
  header: z.string().min(1),
  algorithm: z.enum(['sha1', 'sha256', 'sha512']),
  encoding: z.enum(['hex', 'base64']),
});

function readHmacSettings(
  configPublic: Record<string, unknown>,
): { header: string; algorithm: HmacAlgorithm; encoding: HmacEncoding } | undefined {
  if (configPublic['hmac'] === undefined) return undefined;
  const parsed = hmacSettingsSchema.safeParse(configPublic['hmac']);
  return parsed.success ? parsed.data : undefined;
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortDeep((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Order-independent so logically identical payloads with reordered keys hash the same. */
function canonicalHash(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(sortDeep(payload)))
    .digest('hex');
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Public ingest endpoint (MASTER_PLAN section 5). Registered in its own encapsulated context so
 * its raw-body content-type parsers do not affect any other route. */
export function registerIngestRoutes(app: App, ctx: AppContext): void {
  app.register(async (instance: App) => {
    instance.addContentTypeParser(
      ['application/json', 'application/x-www-form-urlencoded', 'text/plain'],
      { parseAs: 'buffer' },
      (request, body, done) => {
        const buffer = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
        request.rawBody = buffer;
        done(null, buffer);
      },
    );

    instance.post(
      '/i/:ingestToken',
      {
        bodyLimit: LIMITS.ingestBodyBytes,
        schema: { params: paramsSchema },
        config: {
          rateLimit: {
            max: 120,
            timeWindow: '1 minute',
            keyGenerator: (request) =>
              `ingest:${(request.params as { ingestToken: string }).ingestToken}`,
          },
        },
      },
      async (request, reply) => {
        const relay = await findRelayByIngestToken(ctx.db, request.params.ingestToken);
        if (!relay) {
          request.log.info('ingest: unknown token');
          reply.status(404);
          return { error: { code: 'NOT_FOUND', message: 'Unknown ingest token' } };
        }
        if (relay.status !== 'active') {
          request.log.info({ relayId: relay.id }, 'ingest: relay inactive');
          reply.status(409);
          return { error: { code: 'RELAY_INACTIVE', message: 'Relay is inactive' } };
        }

        const contentType = (request.headers['content-type'] ?? '').split(';')[0]?.trim();
        const raw = request.rawBody ?? Buffer.alloc(0);
        let payload: unknown;
        if (contentType === 'application/json') {
          try {
            payload = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : {};
          } catch {
            reply.status(400);
            return { error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' } };
          }
        } else if (contentType === 'application/x-www-form-urlencoded') {
          payload = Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
        } else if (contentType === 'text/plain' || contentType === '') {
          payload = raw.toString('utf8');
        } else {
          reply.status(415);
          return {
            error: {
              code: 'UNSUPPORTED_CONTENT_TYPE',
              message: `Content type "${contentType}" is not supported`,
            },
          };
        }

        const hmacSettings = readHmacSettings(relay.configPublic);
        if (hmacSettings) {
          const secretFields = decryptRelaySecret(ctx.keyring, relay);
          const secret =
            typeof secretFields['hmacSecret'] === 'string' ? secretFields['hmacSecret'] : '';
          const ok = verifyHmac({
            rawBody: raw,
            secret,
            signature: firstHeader(request.headers[hmacSettings.header]),
            algorithm: hmacSettings.algorithm,
            encoding: hmacSettings.encoding,
          });
          if (!ok) {
            await createEvent(ctx.db, {
              relayId: relay.id,
              userId: relay.userId,
              source: 'http',
              status: 'REJECTED',
              errorCode: 'HMAC_INVALID',
              payloadIn: payload,
            });
            reply.status(401);
            return { error: { code: 'HMAC_INVALID', message: 'Signature verification failed' } };
          }
        }

        const idempotencyKey = firstHeader(request.headers['idempotency-key']);
        const dedupeHash = idempotencyKey
          ? createHash('sha256').update(idempotencyKey).digest('hex')
          : undefined;
        if (dedupeHash) {
          const existing = await findRecentEventByDedupeHash(ctx.db, relay.id, dedupeHash);
          if (existing) {
            reply.status(202);
            return { eventId: existing.id };
          }
        }

        // Loop guard: Redis INCR with a 60 s TTL set only on the first hit in the window.
        const loopKey = `loop:${relay.id}:${canonicalHash(payload)}`;
        const count = await ctx.redis.incr(loopKey);
        if (count === 1) await ctx.redis.expire(loopKey, LOOP_GUARD_WINDOW_S);
        if (count > LOOP_GUARD_THRESHOLD) {
          await createEvent(ctx.db, {
            relayId: relay.id,
            userId: relay.userId,
            source: 'http',
            status: 'DROPPED_LOOP',
            errorCode: 'LOOP_DETECTED',
            payloadIn: payload,
            ...(dedupeHash === undefined ? {} : { dedupeHash }),
          });
          // MASTER_PLAN section 7: "one deduped email" per loop, not one per dropped request —
          // dedupe key covers this relay for the rest of the 60s guard window it's already inside.
          const shouldNotify = await tryRecordNotification(ctx.db, {
            userId: relay.userId,
            kind: 'loop-detected',
            dedupeKey: `loop-detected:${relay.id}:${Math.floor(Date.now() / (LOOP_GUARD_WINDOW_S * 1000))}`,
          });
          if (shouldNotify) {
            const user = await findUserById(ctx.db, relay.userId);
            if (user) {
              await ctx.mailer.send({
                to: user.email,
                subject: `SmartRelay: relay "${relay.name}" looks like it's looping`,
                text:
                  `More than ${LOOP_GUARD_THRESHOLD} identical requests hit "${relay.name}" within ` +
                  `${LOOP_GUARD_WINDOW_S} seconds, so SmartRelay stopped relaying them (not billed). ` +
                  'This usually means the destination is replying in a way that re-triggers the same relay.',
              });
            }
          }
          reply.status(429);
          return { error: { code: 'LOOP_DETECTED', message: 'Too many identical requests' } };
        }

        const relayModule = ctx.modules[relay.type];
        if (!relayModule) {
          reply.status(503);
          return {
            error: {
              code: 'MODULE_NOT_IMPLEMENTED',
              message: `${relay.type} is not implemented yet`,
            },
          };
        }

        const secretFields = decryptRelaySecret(ctx.keyring, relay);
        const mergedConfig = { ...relay.configPublic, ...secretFields };
        const parsedConfig = relayModule.configSchema.safeParse(mergedConfig);
        if (!parsedConfig.success) {
          request.log.error({ relayId: relay.id }, 'ingest: relay configuration is invalid');
          const event = await createEvent(ctx.db, {
            relayId: relay.id,
            userId: relay.userId,
            source: 'http',
            status: 'FAILED',
            errorCode: 'RELAY_CONFIG_INVALID',
            payloadIn: payload,
            ...(dedupeHash === undefined ? {} : { dedupeHash }),
          });
          reply.status(500);
          return {
            error: { code: 'RELAY_CONFIG_INVALID', message: 'Relay configuration is invalid' },
            eventId: event.id,
          };
        }

        const priceKind = relayModule.priceKind(parsedConfig.data);
        const priceMicro = await getPriceMicro(ctx.db, priceKind);
        const balance = await getBalance(ctx.db, relay.userId);

        if (balance < priceMicro) {
          const event = await createEvent(ctx.db, {
            relayId: relay.id,
            userId: relay.userId,
            source: 'http',
            status: 'HELD_NO_CREDIT',
            payloadIn: payload,
            heldUntil: new Date(Date.now() + HELD_EVENT_TTL_MS),
            ...(dedupeHash === undefined ? {} : { dedupeHash }),
          });
          reply.status(202);
          return { eventId: event.id, held: true };
        }

        const event = await createEvent(ctx.db, {
          relayId: relay.id,
          userId: relay.userId,
          source: 'http',
          status: 'RECEIVED',
          payloadIn: payload,
          ...(dedupeHash === undefined ? {} : { dedupeHash }),
        });
        await touchLastTriggered(ctx.db, relay.id);
        await ctx.deliverQueue.add(
          'deliver',
          { eventId: event.id },
          { jobId: event.id, attempts: DELIVER_MAX_ATTEMPTS, backoff: { type: 'custom' } },
        );
        await markQueued(ctx.db, event.id);

        reply.status(202);
        return { eventId: event.id };
      },
    );
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}
