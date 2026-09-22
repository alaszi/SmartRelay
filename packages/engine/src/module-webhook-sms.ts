import { LIMITS } from '@smartrelay/shared';
import { z } from 'zod';
import { queryFirst } from './jsonpath';
import type { ModuleResult, RelayModule } from './module';
import { normalizePhone, PhoneError } from './phone';
import { calculateSmsSegments } from './sms-segments';
import {
  infobipProvider,
  smsLinkProvider,
  twilioProvider,
  type SmsProvider,
  type SmsSendResult,
} from './sms-providers';
import { renderTemplate, TemplateError } from './template';

const templateField = z.string().min(1).max(LIMITS.maxTemplateLength);
const recipientPathField = z.string().min(1).max(LIMITS.maxJsonPathLength);

const smsLinkConfigSchema = z.object({
  provider: z.literal('smslink'),
  connectionId: z.string().min(1),
  password: z.string().min(1),
  recipientPath: recipientPathField,
  template: templateField,
});

const twilioConfigSchema = z.object({
  provider: z.literal('twilio'),
  accountSid: z.string().min(1),
  authToken: z.string().min(1),
  from: z.string().min(1),
  recipientPath: recipientPathField,
  template: templateField,
});

const infobipConfigSchema = z.object({
  provider: z.literal('infobip'),
  apiKey: z.string().min(1),
  baseUrl: z.url(),
  recipientPath: recipientPathField,
  template: templateField,
});

/** Required config for Module 1 (MASTER_PLAN section 6). HMAC (Advanced) is read generically at
 * the ingest pipeline level from `relays.config_public.hmac`, not part of this schema. */
export const webhookSmsConfigSchema = z.discriminatedUnion('provider', [
  smsLinkConfigSchema,
  twilioConfigSchema,
  infobipConfigSchema,
]);

export type WebhookSmsConfig = z.infer<typeof webhookSmsConfigSchema>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PROVIDERS: Record<WebhookSmsConfig['provider'], SmsProvider<any>> = {
  smslink: smsLinkProvider,
  twilio: twilioProvider,
  infobip: infobipProvider,
};

function toModuleResult(send: SmsSendResult, request: { to: string; text: string }): ModuleResult {
  if (send.ok) {
    return {
      ok: true,
      statusCode: send.statusCode,
      request,
      response: send.response,
      ...(send.providerMessageId === undefined
        ? {}
        : { extra: { providerMessageId: send.providerMessageId } }),
    };
  }
  return {
    ok: false,
    retryable: send.retryable,
    errorCode: send.errorCode,
    message: send.message,
    ...(send.statusCode === undefined ? {} : { statusCode: send.statusCode }),
    request,
    ...(send.response === undefined ? {} : { response: send.response }),
  };
}

/** Module 1: Webhook -> SMS (MASTER_PLAN section 6). SMSLink and Twilio are live; Infobip is a
 * typed stub (decision D2). Always priced as `sms_dispatch` (BYO mode, decision D1). */
export const webhookSmsModule: RelayModule<WebhookSmsConfig> = {
  type: 'webhook_sms',
  configSchema: webhookSmsConfigSchema,
  priceKind: () => 'sms_dispatch',
  sampleInput: () => ({ customer: { name: 'Ana', phone: '0722123456' } }),

  async execute({ config, payload, ctx }) {
    const recipient = queryFirst(payload, config.recipientPath);
    if (!recipient.found) {
      return {
        ok: false,
        retryable: false,
        errorCode: 'RECIPIENT_PATH_MISSING',
        message: `Recipient path ${config.recipientPath} did not match the payload`,
      };
    }

    let phone: string;
    try {
      phone = normalizePhone(recipient.value);
    } catch (error) {
      if (error instanceof PhoneError) {
        return { ok: false, retryable: false, errorCode: error.code, message: error.message };
      }
      throw error;
    }

    let text: string;
    try {
      text = renderTemplate(config.template, payload);
    } catch (error) {
      if (error instanceof TemplateError) {
        return { ok: false, retryable: false, errorCode: error.code, message: error.message };
      }
      throw error;
    }

    const provider = PROVIDERS[config.provider];
    const send = await provider.send(config, { to: phone, text, http: ctx.http });
    const result = toModuleResult(send, { to: phone, text });

    if (result.ok) {
      const segments = calculateSmsSegments(text);
      result.extra = { ...result.extra, segments: segments.segments, encoding: segments.encoding };
    }
    return result;
  },
};
