import { timingSafeEqual } from 'node:crypto';
import { answerTelegramCallback } from '@smartrelay/engine';
import { createEvent, decryptRelaySecret, getRelayInternal } from '@smartrelay/db';
import { z } from 'zod';
import type { App } from '../app';
import type { AppContext } from '../context';

// Telegram's Update object (core.telegram.org/bots/api#update); only the callback_query shape
// this route acts on is parsed, everything else is ignored.
const telegramUpdateSchema = z
  .object({
    callback_query: z
      .object({
        id: z.string(),
        data: z.string().optional(),
        from: z
          .object({
            id: z.number(),
            username: z.string().optional(),
            first_name: z.string().optional(),
          })
          .optional(),
        message: z.unknown().optional(),
      })
      .optional(),
  })
  .passthrough();

function secretMatches(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Telegram inline-button callback trigger (MASTER_PLAN section 6, decision D5): the callback is
 * logged as an inbound event and acknowledged via `answerCallbackQuery`; there is no further
 * forwarding in v1. Registered per relay with `setWebhook` when the relay is saved (Phase 4).
 */
export function registerTelegramCallbackRoutes(app: App, ctx: AppContext): void {
  app.post(
    '/tg/:relayId/:secret',
    { schema: { params: z.object({ relayId: z.string().min(1), secret: z.string().min(1) }) } },
    async (request, reply) => {
      const { relayId, secret } = request.params;

      const relay = await getRelayInternal(ctx.db, relayId);
      if (!relay || relay.type !== 'chat_relay' || relay.configPublic['platform'] !== 'telegram') {
        reply.status(404);
        return { error: { code: 'NOT_FOUND', message: 'Unknown Telegram relay' } };
      }

      const secretFields = decryptRelaySecret(ctx.keyring, relay);
      const expectedSecret = secretFields['tgCallbackSecret'];
      const botToken = secretFields['botToken'];
      if (typeof expectedSecret !== 'string' || !secretMatches(secret, expectedSecret)) {
        reply.status(401);
        return { error: { code: 'UNAUTHENTICATED', message: 'Invalid callback secret' } };
      }
      if (typeof botToken !== 'string') {
        reply.status(404);
        return { error: { code: 'NOT_FOUND', message: 'Unknown Telegram relay' } };
      }

      const parsed = telegramUpdateSchema.safeParse(request.body);
      const callbackQuery = parsed.success ? parsed.data.callback_query : undefined;
      if (!callbackQuery) {
        reply.status(200);
        return { ok: true };
      }

      await createEvent(ctx.db, {
        relayId: relay.id,
        userId: relay.userId,
        source: 'telegram_callback',
        status: 'SUCCESS',
        payloadIn: callbackQuery,
      });
      await answerTelegramCallback(botToken, callbackQuery.id, ctx.http);

      reply.status(200);
      return { ok: true };
    },
  );
}
