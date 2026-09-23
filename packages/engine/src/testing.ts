import Stripe from 'stripe';
import { z } from 'zod';
import type { PricingKind, RelayType } from '@smartrelay/shared';
import type { RelayModule } from './module';
import { SafeHttpError } from './safe-http';
import { renderTemplate, TemplateError } from './template';

/**
 * Signs a webhook payload exactly the way Stripe does (a real `Stripe-Signature` header,
 * verifiable by the unmodified `PaymentProvider.handleWebhook`), so integration tests can prove
 * replay-idempotency against the real signature-verification code path instead of mocking it away.
 * `new Stripe(...)` here needs no real API key: `webhooks.generateTestHeaderString` is a local HMAC
 * computation, no network call. Never imported from production code.
 */
export function signStripeWebhookForTest(input: { payload: string; secret: string }): string {
  return new Stripe('sk_test_unused').webhooks.generateTestHeaderString({
    payload: input.payload,
    secret: input.secret,
  });
}

/**
 * Test-only fixture (MASTER_PLAN Phase 2: "Ship with a fake echo module used only in tests to
 * prove the whole pipeline before real adapters"). Renders a template and POSTs it to a URL,
 * mirroring Module 2's shape closely enough to exercise the full ingest -> deliver -> charge
 * pipeline against a real local HTTP server, including retryable vs terminal classification.
 * Never imported from production code (see the package's "./testing" export).
 */

export const echoConfigSchema = z.object({ url: z.string(), template: z.string() });
export type EchoConfig = z.infer<typeof echoConfigSchema>;

export function createEchoModule(
  type: RelayType = 'webhook_sms',
  priceKind: PricingKind = 'relay_http',
  /** Test-only hook for exercising `runDeliverJob`'s generic follow-up scheduling
   * (packages/db/src/deliver.ts) without needing the real calendar-bridge module + a mocked
   * Google Calendar API. Undefined (the default) matches every other module with no follow-up. */
  scheduleFollowUp?: RelayModule<EchoConfig>['scheduleFollowUp'],
): RelayModule<EchoConfig> {
  return {
    type,
    configSchema: echoConfigSchema,
    priceKind: () => priceKind,
    sampleInput: () => ({ message: 'hello' }),
    ...(scheduleFollowUp ? { scheduleFollowUp } : {}),
    async execute({ config, payload, ctx }) {
      let body: string;
      try {
        body = renderTemplate(config.template, payload);
      } catch (error) {
        if (error instanceof TemplateError) {
          return { ok: false, retryable: false, errorCode: error.code, message: error.message };
        }
        throw error;
      }

      try {
        const response = await ctx.http.request({
          url: config.url,
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body,
        });
        if (response.status >= 200 && response.status < 300) {
          return {
            ok: true,
            statusCode: response.status,
            request: { body },
            response: response.body,
          };
        }
        return {
          ok: false,
          retryable: response.status >= 500 || response.status === 429,
          errorCode: 'DESTINATION_ERROR',
          message: `Destination answered ${response.status}`,
          statusCode: response.status,
          request: { body },
          response: response.body,
        };
      } catch (error) {
        if (error instanceof SafeHttpError) {
          return {
            ok: false,
            retryable: error.retryable,
            errorCode: error.code,
            message: error.message,
          };
        }
        throw error;
      }
    },
  };
}
