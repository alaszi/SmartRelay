import { LIMITS } from '@smartrelay/shared';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { createGoogleCalendarEvent, refreshGoogleAccessToken } from './google-calendar';
import { queryFirst } from './jsonpath';
import type { ModuleResult, RelayModule } from './module';
import { renderTemplate, TemplateError } from './template';

const templateField = z.string().min(1).max(LIMITS.maxTemplateLength);
const pathField = z.string().min(1).max(LIMITS.maxJsonPathLength);

/**
 * Module 4's Advanced "SMS reminder" (MASTER_PLAN section 6): a checkbox + offset that, when on,
 * reveals a recipient phone JSONPath and SMS provider credentials — the same shape as Module 1's
 * required fields, so `reminderMode` doubles as both "is it on" and "which provider," mirroring
 * `webhook_sms`'s own `provider` discriminant. Every field is flat at the top level (not nested
 * under a shared `reminder` key) because `relays.config_secret` patches are a *shallow* merge onto
 * whatever is already stored (`updateRelay`, packages/db/src/relays.ts) — a nested secret field
 * would get silently dropped by that merge whenever some other top-level field changed without it.
 * The one secret this needs (whichever credential the chosen provider needs) is `reminderSecret`;
 * everything else here is non-secret and lives in `configPublic`.
 */
const reminderOffSchema = z.object({ reminderMode: z.literal('off') });

const reminderBaseSchema = z.object({
  reminderOffsetMinutes: z
    .number()
    .int()
    .min(1)
    .max(7 * 24 * 60),
  reminderRecipientPath: pathField,
  reminderTemplate: templateField,
});

const reminderSmsLinkSchema = reminderBaseSchema.extend({
  reminderMode: z.literal('smslink'),
  reminderConnectionId: z.string().min(1),
  reminderSecret: z.string().min(1),
});

const reminderTwilioSchema = reminderBaseSchema.extend({
  reminderMode: z.literal('twilio'),
  reminderAccountSid: z.string().min(1),
  reminderFrom: z.string().min(1),
  reminderSecret: z.string().min(1),
});

const reminderInfobipSchema = reminderBaseSchema.extend({
  reminderMode: z.literal('infobip'),
  reminderBaseUrl: z.url(),
  reminderSecret: z.string().min(1),
});

const reminderConfigSchema = z.discriminatedUnion('reminderMode', [
  reminderOffSchema,
  reminderSmsLinkSchema,
  reminderTwilioSchema,
  reminderInfobipSchema,
]);

export type ReminderConfig = z.infer<typeof reminderConfigSchema>;

const calendarBridgeBaseSchema = z.object({
  titleTemplate: templateField,
  startPath: pathField,
  endPath: pathField,
  refreshToken: z.string().min(1),
});

/** MASTER_PLAN section 6, decision D4: Google Calendar only in v1, so no provider discriminant.
 * `refreshToken` lives in `relays.config_secret`, encrypted the same way as every other module's
 * secret fields; the app's own OAuth client (shared across users) arrives via `ctx.google`.
 *
 * The reminder feature shipped after calendar_bridge itself, so a stored relay's config may simply
 * not have `reminderMode` at all (every relay created before this feature existed, plus most tests)
 * — that's not the same as an explicit `reminderMode: 'off'` fields-wise, but means the same thing,
 * so this preprocess step fills it in before the discriminated union has to match on it. */
export const calendarBridgeConfigSchema = z.preprocess((input) => {
  if (input && typeof input === 'object' && !('reminderMode' in input)) {
    return { ...input, reminderMode: 'off' };
  }
  return input;
}, calendarBridgeBaseSchema.and(reminderConfigSchema));

export type CalendarBridgeConfig = z.infer<typeof calendarBridgeConfigSchema>;

const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/;

type TimestampResult =
  { ok: true; iso: string; dt: DateTime } | { ok: false; errorCode: string; message: string };

/**
 * A timestamp carrying an explicit UTC offset (or "Z") is used as-is; one without an offset is
 * interpreted in the account timezone (MASTER_PLAN section 6).
 */
function extractTimestamp(
  payload: unknown,
  path: string,
  field: 'start' | 'end',
  accountTimezone: string,
): TimestampResult {
  const result = queryFirst(payload, path);
  if (!result.found || typeof result.value !== 'string') {
    return {
      ok: false,
      errorCode: field === 'start' ? 'START_PATH_MISSING' : 'END_PATH_MISSING',
      message: `${field}Path ${path} did not match a string in the payload`,
    };
  }

  const hasOffset = HAS_OFFSET.test(result.value.trim());
  const dt = hasOffset
    ? DateTime.fromISO(result.value, { setZone: true })
    : DateTime.fromISO(result.value, { zone: accountTimezone });

  if (!dt.isValid) {
    return {
      ok: false,
      errorCode: field === 'start' ? 'INVALID_START_TIME' : 'INVALID_END_TIME',
      // Never the extracted value itself (MASTER_PLAN section 7: no payload content in app logs —
      // this message ends up in delivery_attempts.error_message and the worker's stderr, neither
      // of which are payload-safe places).
      message: `${field}Path ${path} did not match a valid ISO 8601 timestamp`,
    };
  }
  return { ok: true, iso: dt.toISO() ?? result.value, dt };
}

/** Module 4: Calendar Bridge (MASTER_PLAN section 6). Always priced as `calendar_event`. */
export const calendarBridgeModule: RelayModule<CalendarBridgeConfig> = {
  type: 'calendar_bridge',
  configSchema: calendarBridgeConfigSchema,
  priceKind: () => 'calendar_event',
  sampleInput: () => ({
    customer: { name: 'Ana' },
    booking: { start: '2026-03-01T10:00:00+02:00', end: '2026-03-01T11:00:00+02:00' },
  }),

  async execute({ config, payload, ctx }): Promise<ModuleResult> {
    let summary: string;
    try {
      summary = renderTemplate(config.titleTemplate, payload);
    } catch (error) {
      if (error instanceof TemplateError) {
        return { ok: false, retryable: false, errorCode: error.code, message: error.message };
      }
      throw error;
    }

    const start = extractTimestamp(payload, config.startPath, 'start', ctx.userTimezone);
    if (!start.ok) {
      return { ok: false, retryable: false, errorCode: start.errorCode, message: start.message };
    }
    const end = extractTimestamp(payload, config.endPath, 'end', ctx.userTimezone);
    if (!end.ok) {
      return { ok: false, retryable: false, errorCode: end.errorCode, message: end.message };
    }
    if (end.dt.toMillis() <= start.dt.toMillis()) {
      return {
        ok: false,
        retryable: false,
        errorCode: 'INVALID_TIME_RANGE',
        message: 'end must be after start',
      };
    }

    if (!ctx.google) {
      return {
        ok: false,
        retryable: false,
        errorCode: 'GOOGLE_OAUTH_NOT_CONFIGURED',
        message: 'GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are not configured on this deployment',
      };
    }

    const token = await refreshGoogleAccessToken({
      clientId: ctx.google.clientId,
      clientSecret: ctx.google.clientSecret,
      refreshToken: config.refreshToken,
      http: ctx.http,
    });
    if (!token.ok) {
      return token.revoked
        ? { ok: false, retryable: false, errorCode: 'GOOGLE_AUTH_REVOKED', message: token.message }
        : {
            ok: false,
            retryable: token.retryable,
            errorCode: 'GOOGLE_TOKEN_REFRESH_FAILED',
            message: token.message,
          };
    }

    const send = await createGoogleCalendarEvent({
      accessToken: token.accessToken,
      summary,
      startIso: start.iso,
      endIso: end.iso,
      http: ctx.http,
    });
    if (send.ok) {
      return {
        ok: true,
        statusCode: send.statusCode,
        request: send.request,
        response: send.response,
        // startIso lets the caller (packages/db/src/deliver.ts) compute a reminder's runAt without
        // this pure adapter reaching into the DB itself.
        extra: { googleEventId: send.eventId, startIso: start.iso },
      };
    }
    return {
      ok: false,
      retryable: send.retryable,
      errorCode: send.errorCode,
      message: send.message,
      ...(send.statusCode === undefined ? {} : { statusCode: send.statusCode }),
      ...(send.request === undefined ? {} : { request: send.request }),
      ...(send.response === undefined ? {} : { response: send.response }),
    };
  },

  scheduleFollowUp({ config, result }) {
    if (config.reminderMode === 'off') return undefined;
    const startIso = (result.extra as { startIso?: string } | undefined)?.startIso;
    if (!startIso) return undefined;
    const runAt = DateTime.fromISO(startIso).minus({ minutes: config.reminderOffsetMinutes });
    if (!runAt.isValid) return undefined;
    const runAtDate = runAt.toJSDate();
    // Nothing to schedule if the offset already puts the reminder in the past (event starts too
    // soon, or the offset is larger than the time remaining) — sending a "reminder" for a moment
    // that's already gone would be wrong, not just late.
    if (runAtDate.getTime() <= Date.now()) return undefined;
    return { runAt: runAtDate };
  },
};
