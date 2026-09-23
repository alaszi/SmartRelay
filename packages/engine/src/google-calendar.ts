import type { SafeHttpClient } from './safe-http';

// Verified against developers.google.com/identity/protocols/oauth2/web-server (the full
// authorization-code flow: the authorize URL, the code<->token exchange, and offline access via
// access_type=offline) and developers.google.com/calendar/api/v3/reference/events/insert (creating
// an event) plus developers.google.com/workspace/calendar/api/guides/errors (error shape). Google
// Calendar only in v1 (MASTER_PLAN decision D4).
const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const GOOGLE_CALENDAR_PRIMARY_EVENTS_URL =
  'https://www.googleapis.com/calendar/v3/calendars/primary/events';

/** `calendar.events` is the only scope the module ever uses (least privilege, section 8.7);
 * `userinfo.email` is requested purely so the connect flow can label the connection by account
 * email, not for any elevated access. */
export const GOOGLE_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
];

/**
 * The URL to send the user to for Google's consent screen (MASTER_PLAN section 9,
 * `GET /api/oauth/google/start`). `access_type=offline` + `prompt=consent` guarantee a
 * `refresh_token` in the callback's token exchange even when the user has authorized before.
 */
export function buildGoogleAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: GOOGLE_OAUTH_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state: input.state,
  });
  return `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`;
}

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

export type GoogleAuthCodeExchangeResult =
  { ok: true; refreshToken: string; accessToken: string } | { ok: false; message: string };

/**
 * Exchanges the callback's authorization `code` for tokens (`GET /api/oauth/google/callback`).
 * Unlike `refreshGoogleAccessToken`, this always needs a `refresh_token` in the response — Google
 * only omits it when `access_type=offline`/`prompt=consent` were not both set on the redirect that
 * `buildGoogleAuthorizeUrl` always sets, so a missing one here means Google changed behavior, not
 * a normal case to silently tolerate.
 */
export async function exchangeGoogleAuthCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  http: SafeHttpClient;
}): Promise<GoogleAuthCodeExchangeResult> {
  const body = new URLSearchParams({
    code: input.code,
    client_id: input.clientId,
    client_secret: input.clientSecret,
    redirect_uri: input.redirectUri,
    grant_type: 'authorization_code',
  });

  const response = await input.http.request({
    url: GOOGLE_TOKEN_URL,
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  let parsed: (GoogleTokenResponse & { refresh_token?: string }) | undefined;
  try {
    parsed = JSON.parse(response.body) as GoogleTokenResponse & { refresh_token?: string };
  } catch {
    parsed = undefined;
  }

  if (response.status >= 200 && response.status < 300 && parsed?.access_token) {
    if (!parsed.refresh_token) {
      return { ok: false, message: 'Google did not return a refresh token; try connecting again' };
    }
    return { ok: true, refreshToken: parsed.refresh_token, accessToken: parsed.access_token };
  }
  return {
    ok: false,
    message: parsed?.error_description ?? `Google token exchange failed (HTTP ${response.status})`,
  };
}

export type GoogleUserInfoResult = { ok: true; email: string } | { ok: false; message: string };

/** Only used right after `exchangeGoogleAuthCode`, to label a connection by account email. */
export async function fetchGoogleUserEmail(input: {
  accessToken: string;
  http: SafeHttpClient;
}): Promise<GoogleUserInfoResult> {
  const response = await input.http.request({
    url: GOOGLE_USERINFO_URL,
    method: 'GET',
    headers: { authorization: `Bearer ${input.accessToken}` },
  });

  let parsed: { email?: string } | undefined;
  try {
    parsed = JSON.parse(response.body) as { email?: string };
  } catch {
    parsed = undefined;
  }

  if (response.status >= 200 && response.status < 300 && typeof parsed?.email === 'string') {
    return { ok: true, email: parsed.email };
  }
  return {
    ok: false,
    message: `Could not read the connected Google account's email (HTTP ${response.status})`,
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
