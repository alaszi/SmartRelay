import Stripe from 'stripe';

// Verified against docs.stripe.com/api/checkout/sessions/create (mode=payment, price_data line
// items, client_reference_id, metadata, success/cancel URLs) and docs.stripe.com/webhooks
// (constructEvent needs the RAW request body; a Stripe-Signature header is HMAC-SHA256 over
// "<timestamp>.<payload>", verified locally, no network call). MASTER_PLAN section 11.

export interface CreateCheckoutInput {
  amountCents: number;
  currency: string;
  /** The user id: read back off the session in the Stripe Dashboard, never trusted from a
   * webhook body — see StripePaymentProvider.handleWebhook. */
  clientReferenceId: string;
  metadata: Record<string, string>;
  successUrl: string;
  cancelUrl: string;
}

export interface CreateCheckoutResult {
  sessionId: string;
  url: string | null;
}

export type WebhookEventResult =
  | { ok: true; eventId: string; kind: 'checkout_completed'; sessionId: string }
  | { ok: true; eventId: string; kind: 'ignored' }
  | { ok: false; message: string };

/**
 * `PaymentProvider` interface (MASTER_PLAN section 11): `createCheckout` / `handleWebhook` are the
 * only two operations a route needs, so a future provider (Netopia) is a drop-in behind the same
 * shape. Deliberately thin — it only creates/verifies-and-classifies a checkout, never touches the
 * ledger, `topups` or held events itself; that stays in packages/db (chargeEvent-style
 * provider-agnostic business logic), called by the route after `handleWebhook` tells it what
 * happened.
 */
export interface PaymentProvider {
  createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult>;
  /** Synchronous: signature verification is a local HMAC computation, no network call. */
  handleWebhook(rawBody: Buffer, signature: string): WebhookEventResult;
}

const CHECKOUT_COMPLETED_EVENT_TYPES = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
]);

class StripePaymentProvider implements PaymentProvider {
  readonly #stripe: Stripe;
  readonly #webhookSecret: string;

  constructor(stripe: Stripe, webhookSecret: string) {
    this.#stripe = stripe;
    this.#webhookSecret = webhookSecret;
  }

  async createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult> {
    const session = await this.#stripe.checkout.sessions.create({
      mode: 'payment',
      currency: input.currency,
      client_reference_id: input.clientReferenceId,
      metadata: input.metadata,
      line_items: [
        {
          price_data: {
            currency: input.currency,
            unit_amount: input.amountCents,
            product_data: { name: 'SmartRelay credit top-up' },
          },
          quantity: 1,
        },
      ],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    });
    return { sessionId: session.id, url: session.url };
  }

  handleWebhook(rawBody: Buffer, signature: string): WebhookEventResult {
    let event: Stripe.Event;
    try {
      event = this.#stripe.webhooks.constructEvent(rawBody, signature, this.#webhookSecret);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : 'invalid signature' };
    }

    if (!CHECKOUT_COMPLETED_EVENT_TYPES.has(event.type)) {
      return { ok: true, eventId: event.id, kind: 'ignored' };
    }
    const session = event.data.object as Stripe.Checkout.Session;
    return { ok: true, eventId: event.id, kind: 'checkout_completed', sessionId: session.id };
  }
}

export function createStripePaymentProvider(
  secretKey: string,
  webhookSecret: string,
): PaymentProvider {
  return new StripePaymentProvider(new Stripe(secretKey), webhookSecret);
}
