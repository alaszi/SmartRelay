import type { SafeHttpClient } from './safe-http';

// Verified against developers.google.com/identity/protocols/oauth2/web-server#offline
// (refreshing an access token) and developers.google.com/calendar/api/v3/reference/events/insert
// (creating an event) plus developers.google.com/workspace/calendar/api/guides/errors (error
// shape). Google Calendar only in v1 (MASTER_PLAN decision D4).
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_CALENDAR_PRIMARY_EVENTS_URL =
  'https://www.googleapis.com/calendar/v3/calendars/primary/events';

interface GoogleTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

export type GoogleTokenRefreshResult =
  | { ok: true; accessToken: string }
  /** invalid_grant: the refresh token was revoked or expired. Reconnecting is the only fix. */
  | { ok: false; revoked: true; message: string }
  | { ok: false; revoked: false; retryable: boolean; message: string };

/**
 * Exchanges a stored refresh token for a short-lived access token. Called once per delivery
 * attempt (the module never caches an access token between events).
 */
export async function refreshGoogleAccessToken(input: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  http: SafeHttpClient;
}): Promise<GoogleTokenRefreshResult> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    refresh_token: input.refreshToken,
    grant_type: 'refresh_token',
  });

  const response = await input.http.request({
    url: GOOGLE_TOKEN_URL,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  let parsed: GoogleTokenResponse | undefined;
  try {
    parsed = JSON.parse(response.body) as GoogleTokenResponse;
  } catch {
    parsed = undefined;
  }

  if (response.status >= 200 && response.status < 300 && parsed?.access_token) {
    return { ok: true, accessToken: parsed.access_token };
  }
  if (parsed?.error === 'invalid_grant') {
    return {
      ok: false,
      revoked: true,
      message: parsed.error_description ?? 'Google refresh token is invalid or revoked',
    };
  }
  return {
    ok: false,
    revoked: false,
    retryable: response.status >= 500,
    message: parsed?.error_description ?? `Google token refresh failed (HTTP ${response.status})`,
  };
}

interface GoogleCalendarErrorBody {
  error?: { code?: number; message?: string; errors?: { reason?: string }[] };
}

export type GoogleCalendarEventResult =
  | { ok: true; statusCode: number; eventId: string; request: unknown; response: unknown }
  | {
      ok: false;
      retryable: boolean;
      /** True on a 401: the access token was rejected even though the refresh just succeeded. */
      revoked: boolean;
      errorCode: string;
      message: string;
      statusCode?: number;
      request?: unknown;
      response?: unknown;
    };

/** Inserts one event on the connected account's primary calendar. */
export async function createGoogleCalendarEvent(input: {
  accessToken: string;
  summary: string;
  /** RFC3339, always carrying an explicit UTC offset (the module resolves the account timezone
   * before calling this). */
  startIso: string;
  endIso: string;
  http: SafeHttpClient;
}): Promise<GoogleCalendarEventResult> {
  const requestBody = {
    summary: input.summary,
    start: { dateTime: input.startIso },
    end: { dateTime: input.endIso },
  };

  const response = await input.http.request({
    url: GOOGLE_CALENDAR_PRIMARY_EVENTS_URL,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${input.accessToken}`,
    },
    body: JSON.stringify(requestBody),
  });

  let parsed: unknown;
  try {
    parsed = response.body.length > 0 ? JSON.parse(response.body) : undefined;
  } catch {
    parsed = response.body;
  }

  if (response.status >= 200 && response.status < 300) {
    const result = parsed as { id?: string } | undefined;
    return {
      ok: true,
      statusCode: response.status,
      eventId: result?.id ?? '',
      request: requestBody,
      response: parsed,
    };
  }

  const errorBody = parsed as GoogleCalendarErrorBody | undefined;
  const reason = errorBody?.error?.errors?.[0]?.reason;
  const revoked = response.status === 401;
  const retryable =
    !revoked &&
    (response.status >= 500 || response.status === 429 || reason === 'rateLimitExceeded');
  return {
    ok: false,
    retryable,
    revoked,
    errorCode: revoked ? 'GOOGLE_AUTH_REVOKED' : `GOOGLE_CALENDAR_${response.status}`,
    message: errorBody?.error?.message ?? `Google Calendar answered HTTP ${response.status}`,
    statusCode: response.status,
    request: requestBody,
    response: parsed,
  };
}
