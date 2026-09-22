import { LIMITS } from '@smartrelay/shared';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { createGoogleCalendarEvent, refreshGoogleAccessToken } from './google-calendar';
import { queryFirst } from './jsonpath';
import type { ModuleResult, RelayModule } from './module';
import { renderTemplate, TemplateError } from './template';

const templateField = z.string().min(1).max(LIMITS.maxTemplateLength);
const pathField = z.string().min(1).max(LIMITS.maxJsonPathLength);

/** MASTER_PLAN section 6, decision D4: Google Calendar only in v1, so no provider discriminant.
 * `refreshToken` lives in `relays.config_secret`, encrypted the same way as every other module's
 * secret fields; the app's own OAuth client (shared across users) arrives via `ctx.google`. */
export const calendarBridgeConfigSchema = z.object({
  titleTemplate: templateField,
  startPath: pathField,
  endPath: pathField,
  refreshToken: z.string().min(1),
});

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
      message: `${field}Path ${path} value "${result.value}" is not a valid ISO 8601 timestamp`,
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
        extra: { googleEventId: send.eventId },
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
};
