import { queryFirst } from './jsonpath';
import type { ModuleResult } from './module';
import { normalizePhone, PhoneError } from './phone';
import type { SafeHttpClient } from './safe-http';
import { calculateSmsSegments } from './sms-segments';
import {
  infobipProvider,
  smsLinkProvider,
  twilioProvider,
  type SmsProvider,
} from './sms-providers';
import { renderTemplate, TemplateError } from './template';
import type { ReminderConfig } from './module-calendar-bridge';

type EnabledReminderConfig = Extract<
  ReminderConfig,
  { reminderMode: 'smslink' | 'twilio' | 'infobip' }
>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PROVIDERS: Record<EnabledReminderConfig['reminderMode'], SmsProvider<any>> = {
  smslink: smsLinkProvider,
  twilio: twilioProvider,
  infobip: infobipProvider,
};

function toProviderCredentials(config: EnabledReminderConfig): unknown {
  switch (config.reminderMode) {
    case 'smslink':
      return { connectionId: config.reminderConnectionId, password: config.reminderSecret };
    case 'twilio':
      return {
        accountSid: config.reminderAccountSid,
        authToken: config.reminderSecret,
        from: config.reminderFrom,
      };
    case 'infobip':
      return { baseUrl: config.reminderBaseUrl, apiKey: config.reminderSecret };
  }
}

/**
 * Sends Module 4's Advanced "SMS reminder" (MASTER_PLAN section 6). Deliberately not a
 * `RelayModule`: it isn't triggered by an incoming payload through the ingest pipeline, it's a
 * delayed action fired from `scheduled_reminders` — but everything about *sending* one SMS is
 * identical to `module-webhook-sms.ts`'s `execute()`, so this mirrors that function exactly (same
 * phone normalization, same provider dispatch, same segment accounting) against the reminder's own
 * flat config shape instead of a relay's `WebhookSmsConfig`.
 */
export async function sendReminderSms(
  config: EnabledReminderConfig,
  payload: unknown,
  http: SafeHttpClient,
): Promise<ModuleResult> {
  const recipient = queryFirst(payload, config.reminderRecipientPath);
  if (!recipient.found) {
    return {
      ok: false,
      retryable: false,
      errorCode: 'RECIPIENT_PATH_MISSING',
      message: `Recipient path ${config.reminderRecipientPath} did not match the payload`,
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
    text = renderTemplate(config.reminderTemplate, payload);
  } catch (error) {
    if (error instanceof TemplateError) {
      return { ok: false, retryable: false, errorCode: error.code, message: error.message };
    }
    throw error;
  }

  const provider = PROVIDERS[config.reminderMode];
  const send = await provider.send(toProviderCredentials(config), { to: phone, text, http });

  if (send.ok) {
    const segments = calculateSmsSegments(text);
    return {
      ok: true,
      statusCode: send.statusCode,
      request: { to: phone, text },
      response: send.response,
      extra: {
        providerMessageId: send.providerMessageId,
        segments: segments.segments,
        encoding: segments.encoding,
      },
    };
  }
  return {
    ok: false,
    retryable: send.retryable,
    errorCode: send.errorCode,
    message: send.message,
    ...(send.statusCode === undefined ? {} : { statusCode: send.statusCode }),
    request: { to: phone, text },
    ...(send.response === undefined ? {} : { response: send.response }),
  };
}
