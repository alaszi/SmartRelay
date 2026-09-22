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
import type Stripe from 'stripe';
import { z } from 'zod';
import type { App } from '../app';
import type { AppContext } from '../context';
import { HttpError } from '../http-error';
import { requireAuth } from '../session';

const checkoutSchema = z.object({ amountEur: z.number().min(5).max(100) });

const CHECKOUT_EVENT_TYPES = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
]);

/** Credits a paid Checkout Session and releases any held events (MASTER_PLAN section 11).
 * Idempotent: replaying the same session/event id changes nothing on a second call. */
async function creditCheckoutSession(
  ctx: AppContext,
  session: Stripe.Checkout.Session,
): Promise<void> {
  const topup = await markTopupPaid(ctx.db, session.id);
  if (!topup || !topup.userId) return; // already credited, or not one of our sessions

  await creditTopup(ctx.db, {
    userId: topup.userId,
    amountMicro: centsToMicro(topup.amountCents),
    providerSessionId: session.id,
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
      if (!ctx.stripe) throw new HttpError(503, 'INTERNAL_ERROR', 'Billing is not configured');
      const user = request.authUser!;
      const amountCents = Math.round(request.body.amountEur * 100);

      const topup = await createTopup(ctx.db, { userId: user.id, provider: 'stripe', amountCents });

      const session = await ctx.stripe.checkout.sessions.create({
        mode: 'payment',
        currency: 'eur',
        client_reference_id: user.id,
        metadata: { topupId: topup.id },
        line_items: [
          {
            price_data: {
              currency: 'eur',
              unit_amount: amountCents,
              product_data: { name: 'SmartRelay credit top-up' },
            },
            quantity: 1,
          },
        ],
        success_url: `${ctx.env.APP_URL}/billing?checkout=success`,
        cancel_url: `${ctx.env.APP_URL}/billing?checkout=cancelled`,
      });
      await setTopupProviderSession(ctx.db, topup.id, session.id);

      return { url: session.url };
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
      if (!ctx.stripe || !ctx.env.STRIPE_WEBHOOK_SECRET) {
        reply.status(503);
        return { error: { code: 'INTERNAL_ERROR', message: 'Billing is not configured' } };
      }
      const signature = request.headers['stripe-signature'];
      if (typeof signature !== 'string') {
        reply.status(400);
        return { error: { code: 'VALIDATION_ERROR', message: 'Missing Stripe-Signature header' } };
      }

      let event: Stripe.Event;
      try {
        event = ctx.stripe.webhooks.constructEvent(
          request.body as Buffer,
          signature,
          ctx.env.STRIPE_WEBHOOK_SECRET,
        );
      } catch {
        reply.status(400);
        return { error: { code: 'VALIDATION_ERROR', message: 'Invalid webhook signature' } };
      }

      if (await wasProviderEventProcessed(ctx.db, 'stripe', event.id)) {
        return { received: true };
      }

      if (CHECKOUT_EVENT_TYPES.has(event.type)) {
        await creditCheckoutSession(ctx, event.data.object as Stripe.Checkout.Session);
      }

      return { received: true };
    });
  });
}
