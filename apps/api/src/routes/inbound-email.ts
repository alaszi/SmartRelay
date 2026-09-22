import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createEvent,
  decryptRelaySecret,
  findRecentEventByDedupeHash,
  findRelayByInboundAddress,
  getBalance,
  getPriceMicro,
  markQueued,
  touchLastTriggered,
} from '@smartrelay/db';
import {
  buildDefaultEmailPayload,
  isLoopedEmail,
  matchesEmailFilter,
  type EmailFilter,
  type NormalizedInboundEmail,
} from '@smartrelay/engine';
import { DELIVER_MAX_ATTEMPTS, HELD_EVENT_TTL_MS, LIMITS } from '@smartrelay/shared';
import { z } from 'zod';
import type { App } from '../app';
import type { AppContext } from '../context';

const INBOUND_EMAIL_BODY_LIMIT = 2 * 1024 * 1024; // headroom for base64 attachment metadata; the
// text/html bodies stored in payload_in are separately capped at LIMITS.ingestBodyBytes below.

// Postmark's inbound webhook payload, verified against
// postmarkapp.com/developer/webhooks/inbound-webhook (POST, application/json). OriginalRecipient
// is documented as the exact address the message was sent to (handles multi-recipient/BCC); the
// precise semantics of BCC delivery are not confirmed in the reachable docs (TODO(verify-docs)),
// so `To` is kept as a fallback for the (rare) case OriginalRecipient is absent.
const postmarkHeaderSchema = z.object({ Name: z.string(), Value: z.string() });
const postmarkPayloadSchema = z.object({
  From: z.string(),
  OriginalRecipient: z.string().optional(),
  To: z.string(),
  Subject: z.string().default(''),
  MessageID: z.string(),
  Date: z.string(),
  TextBody: z.string().default(''),
  HtmlBody: z.string().optional(),
  Headers: z.array(postmarkHeaderSchema).default([]),
});

function normalizePostmark(payload: z.infer<typeof postmarkPayloadSchema>): NormalizedInboundEmail {
  const headers: Record<string, string> = {};
  for (const header of payload.Headers) {
    const key = header.Name.toLowerCase();
    if (!(key in headers)) headers[key] = header.Value;
  }

  const receivedAt = new Date(payload.Date);
  return {
    from: payload.From,
    to: payload.OriginalRecipient ?? payload.To,
    subject: payload.Subject,
    receivedAt: Number.isNaN(receivedAt.getTime())
      ? new Date().toISOString()
      : receivedAt.toISOString(),
    messageId: payload.MessageID,
    text: payload.TextBody.slice(0, LIMITS.ingestBodyBytes),
    ...(payload.HtmlBody === undefined
      ? {}
      : { html: payload.HtmlBody.slice(0, LIMITS.ingestBodyBytes) }),
    headers,
  };
}

/**
 * Postmark does not support HMAC signing of webhook payloads (verified: no such mechanism is
 * documented); the recommended way to secure the endpoint is HTTP Basic Auth embedded in the
 * webhook URL. `INBOUND_EMAIL_SECRET` is the expected password; the username is not checked.
 */
function checkBasicAuth(header: string | undefined, secret: string | undefined): boolean {
  if (secret === undefined) return true; // no secret configured (dev only; required in production)
  if (!header?.startsWith('Basic ')) return false;

  let password: string | undefined;
  try {
    password = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':')[1];
  } catch {
    return false;
  }
  if (password === undefined) return false;

  const a = Buffer.from(password);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Inbound email trigger for Module 2 (MASTER_PLAN section 6). Always responds 200: Postmark
 * retries on anything else (except 403, which stops retries outright), so every case this handler
 * can already make a final decision about — unknown recipient, loop guard, filter, hold — must not
 * provoke a retry storm. Only a failed Basic Auth check is rejected outright.
 */
export function registerInboundEmailRoutes(app: App, ctx: AppContext): void {
  app.post(
    '/inbound/email/:provider',
    {
      bodyLimit: INBOUND_EMAIL_BODY_LIMIT,
      schema: { params: z.object({ provider: z.string().min(1) }) },
    },
    async (request, reply) => {
      if (request.params.provider !== ctx.env.INBOUND_EMAIL_PROVIDER) {
        reply.status(404);
        return { error: { code: 'NOT_FOUND', message: 'Unknown inbound email provider' } };
      }
      if (!checkBasicAuth(request.headers.authorization, ctx.env.INBOUND_EMAIL_SECRET)) {
        reply.status(401);
        return {
          error: { code: 'UNAUTHENTICATED', message: 'Invalid inbound webhook credentials' },
        };
      }

      const parsed = postmarkPayloadSchema.safeParse(request.body);
      if (!parsed.success) {
        request.log.warn('inbound email: payload did not match the expected shape');
        reply.status(200);
        return { dropped: true };
      }
      const email = normalizePostmark(parsed.data);

      const relay = await findRelayByInboundAddress(ctx.db, email.to);
      if (!relay || relay.status !== 'active') {
        request.log.info('inbound email: unknown or inactive recipient');
        reply.status(200);
        return { dropped: true };
      }

      if (isLoopedEmail(email, ctx.env.INBOUND_DOMAIN)) {
        await createEvent(ctx.db, {
          relayId: relay.id,
          userId: relay.userId,
          source: 'email',
          status: 'DROPPED_LOOP',
          errorCode: 'LOOP_DETECTED',
          payloadIn: buildDefaultEmailPayload(email),
        });
        reply.status(200);
        return { dropped: true };
      }

      const filter = (relay.configPublic['filter'] as EmailFilter | undefined) ?? undefined;
      if (!matchesEmailFilter(email, filter)) {
        await createEvent(ctx.db, {
          relayId: relay.id,
          userId: relay.userId,
          source: 'email',
          status: 'REJECTED',
          errorCode: 'FILTERED',
          payloadIn: buildDefaultEmailPayload(email),
        });
        reply.status(200);
        return { rejected: true };
      }

      // One message id is one event, even if Postmark redelivers it after a slow/dropped response.
      const dedupeHash = createHash('sha256').update(email.messageId).digest('hex');
      const existing = await findRecentEventByDedupeHash(ctx.db, relay.id, dedupeHash);
      if (existing) {
        reply.status(200);
        return { eventId: existing.id };
      }

      const relayModule = ctx.modules[relay.type];
      if (!relayModule) {
        reply.status(200);
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
        request.log.error({ relayId: relay.id }, 'inbound email: relay configuration is invalid');
        const event = await createEvent(ctx.db, {
          relayId: relay.id,
          userId: relay.userId,
          source: 'email',
          status: 'FAILED',
          errorCode: 'RELAY_CONFIG_INVALID',
          payloadIn: buildDefaultEmailPayload(email),
          dedupeHash,
        });
        reply.status(200);
        return { eventId: event.id };
      }

      const priceKind = relayModule.priceKind(parsedConfig.data);
      const priceMicro = await getPriceMicro(ctx.db, priceKind);
      const balance = await getBalance(ctx.db, relay.userId);
      const payloadIn = buildDefaultEmailPayload(email);

      if (balance < priceMicro) {
        const event = await createEvent(ctx.db, {
          relayId: relay.id,
          userId: relay.userId,
          source: 'email',
          status: 'HELD_NO_CREDIT',
          payloadIn,
          heldUntil: new Date(Date.now() + HELD_EVENT_TTL_MS),
          dedupeHash,
        });
        reply.status(200);
        return { eventId: event.id, held: true };
      }

      const event = await createEvent(ctx.db, {
        relayId: relay.id,
        userId: relay.userId,
        source: 'email',
        status: 'RECEIVED',
        payloadIn,
        dedupeHash,
      });
      await touchLastTriggered(ctx.db, relay.id);
      await ctx.deliverQueue.add(
        'deliver',
        { eventId: event.id },
        { jobId: event.id, attempts: DELIVER_MAX_ATTEMPTS, backoff: { type: 'custom' } },
      );
      await markQueued(ctx.db, event.id);

      reply.status(200);
      return { eventId: event.id };
    },
  );
}
