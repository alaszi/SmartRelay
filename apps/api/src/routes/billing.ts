import {
  createTopup,
  creditTopup,
  getBalance,
  listTopupsForUser,
  markTopupPaid,
  releaseHeldEvents,
  setTopupProviderSession,
  wasProviderEventProcessed,
} from '@smartrelay/db';
import { centsToMicro, DELIVER_MAX_ATTEMPTS, formatMicroEur } from '@smartrelay/shared';
import type { preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { App } from '../app';
import type { AppContext } from '../context';
import { HttpError } from '../http-error';
import { requireAuth } from '../session';

const checkoutSchema = z.object({ amountEur: z.number().min(5).max(100) });

/** Credits a paid Checkout Session (looked up by its own id, never by anything the webhook body
 * claims about amount/user) and releases any held events (MASTER_PLAN section 11 & 7). Idempotent:
 * replaying the same session id changes nothing on a second call — `markTopupPaid` only flips a
 * `pending` row, so an already-`paid` one is a no-op here, and `creditTopup`'s own idempotency key
 * (`topup:<sessionId>`) would refuse a second ledger write even if this guard were bypassed. */
async function creditCheckoutSession(ctx: AppContext, sessionId: string): Promise<void> {
  const topup = await markTopupPaid(ctx.db, sessionId);
  if (!topup || !topup.userId) return; // already credited, or not one of our sessions

  await creditTopup(ctx.db, {
    userId: topup.userId,
    amountMicro: centsToMicro(topup.amountCents),
    providerSessionId: sessionId,
    topupId: topup.id,
  });

  const released = await releaseHeldEvents(ctx.db, topup.userId);
  for (const event of released) {
    await ctx.deliverQueue.add(
      'deliver',
      { eventId: event.id },
      { jobId: event.id, attempts: DELIVER_MAX_ATTEMPTS, backoff: { type: 'custom' } },
    );
  }
}

export function registerBillingRoutes(
  app: App,
  ctx: AppContext,
  options: { sameOrigin: preHandlerHookHandler },
): void {
  const { sameOrigin } = options;
  const auth = requireAuth(ctx);

  app.post(
    '/api/billing/checkout',
    { preHandler: [auth, sameOrigin], schema: { body: checkoutSchema } },
    async (request) => {
      if (!ctx.paymentProvider) {
        throw new HttpError(503, 'INTERNAL_ERROR', 'Billing is not configured');
      }
      const user = request.authUser!;
      const amountCents = Math.round(request.body.amountEur * 100);

      const topup = await createTopup(ctx.db, { userId: user.id, provider: 'stripe', amountCents });

      const checkout = await ctx.paymentProvider.createCheckout({
        amountCents,
        currency: 'eur',
        clientReferenceId: user.id,
        metadata: { topupId: topup.id },
        successUrl: `${ctx.env.APP_URL}/billing?checkout=success`,
        cancelUrl: `${ctx.env.APP_URL}/billing?checkout=cancelled`,
      });
      await setTopupProviderSession(ctx.db, topup.id, checkout.sessionId);

      return { url: checkout.url };
    },
  );

  app.get('/api/billing/history', { preHandler: auth }, async (request) => {
    const user = request.authUser!;
    const [topups, balance] = await Promise.all([
      listTopupsForUser(ctx.db, user.id),
      getBalance(ctx.db, user.id),
    ]);
    return {
      balance: formatMicroEur(balance),
      topups: topups.map((t) => ({
        id: t.id,
        amount: formatMicroEur(centsToMicro(t.amountCents)),
        status: t.status,
        createdAt: t.createdAt,
      })),
    };
  });

  // No session, signature-verified (MASTER_PLAN section 9): registered in its own encapsulated
  // context so its raw-body parser doesn't affect any other route (mirrors ingest.ts).
  app.register(async (instance: App) => {
    instance.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_request, body, done) => done(null, body),
    );

    instance.post('/api/webhooks/stripe', async (request, reply) => {
      if (!ctx.paymentProvider) {
        reply.status(503);
        return { error: { code: 'INTERNAL_ERROR', message: 'Billing is not configured' } };
      }
      const signature = request.headers['stripe-signature'];
      if (typeof signature !== 'string') {
        reply.status(400);
        return { error: { code: 'VALIDATION_ERROR', message: 'Missing Stripe-Signature header' } };
      }

      const result = ctx.paymentProvider.handleWebhook(request.body as Buffer, signature);
      if (!result.ok) {
        reply.status(400);
        return { error: { code: 'VALIDATION_ERROR', message: 'Invalid webhook signature' } };
      }

      if (await wasProviderEventProcessed(ctx.db, 'stripe', result.eventId)) {
        return { received: true };
      }
      if (result.kind === 'checkout_completed') {
        await creditCheckoutSession(ctx, result.sessionId);
      }
      return { received: true };
    });
  });
}
