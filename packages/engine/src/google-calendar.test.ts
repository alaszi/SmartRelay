import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  buildGoogleAuthorizeUrl,
  createGoogleCalendarEvent,
  exchangeGoogleAuthCode,
  fetchGoogleUserEmail,
  refreshGoogleAccessToken,
} from './google-calendar';
import { createSafeHttpClient } from './safe-http';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const http_ = createSafeHttpClient({
  resolver: async () => [{ address: '93.184.216.34', family: 4 }],
});

describe('refreshGoogleAccessToken', () => {
  it('exchanges the refresh token for an access token via a form-encoded POST', async () => {
    let seenBody: string | undefined;
    server.use(
      http.post('https://oauth2.googleapis.com/token', async ({ request }) => {
        seenBody = await request.text();
        expect(request.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
        return HttpResponse.json({
          access_token: 'tok_123',
          expires_in: 3599,
          token_type: 'Bearer',
        });
      }),
    );

    const result = await refreshGoogleAccessToken({
      clientId: 'client-1',
      clientSecret: 'secret-1',
      refreshToken: 'refresh-1',
      http: http_,
    });

    expect(result).toEqual({ ok: true, accessToken: 'tok_123' });
    const params = new URLSearchParams(seenBody);
    expect(params.get('client_id')).toBe('client-1');
    expect(params.get('client_secret')).toBe('secret-1');
    expect(params.get('refresh_token')).toBe('refresh-1');
    expect(params.get('grant_type')).toBe('refresh_token');
  });

  it('reports a revoked/expired token on invalid_grant', async () => {
    server.use(
      http.post('https://oauth2.googleapis.com/token', () =>
        HttpResponse.json(
          { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
          { status: 400 },
        ),
      ),
    );

    const result = await refreshGoogleAccessToken({
      clientId: 'c',
      clientSecret: 's',
      refreshToken: 'r',
      http: http_,
    });

    expect(result).toMatchObject({ ok: false, revoked: true });
  });

  it('treats a 5xx as a retryable, non-revoked failure', async () => {
    server.use(
      http.post('https://oauth2.googleapis.com/token', () =>
        HttpResponse.json({ error: 'server_error' }, { status: 503 }),
      ),
    );

    const result = await refreshGoogleAccessToken({
      clientId: 'c',
      clientSecret: 's',
      refreshToken: 'r',
      http: http_,
    });

    expect(result).toMatchObject({ ok: false, revoked: false, retryable: true });
  });
});

describe('createGoogleCalendarEvent', () => {
  it('POSTs to the primary calendar with a Bearer token and the summary/start/end', async () => {
    let seenAuth: string | null = null;
    let seenBody: { summary?: string; start?: unknown; end?: unknown } | undefined;
    server.use(
      http.post(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        async ({ request }) => {
          seenAuth = request.headers.get('authorization');
          seenBody = (await request.json()) as typeof seenBody;
          return HttpResponse.json({ id: 'evt_abc', htmlLink: 'https://calendar.google.com/x' });
        },
      ),
    );

    const result = await createGoogleCalendarEvent({
      accessToken: 'tok_123',
      summary: 'Order #1042',
      startIso: '2026-03-01T10:00:00+02:00',
      endIso: '2026-03-01T11:00:00+02:00',
      http: http_,
    });

    expect(result).toMatchObject({ ok: true, statusCode: 200, eventId: 'evt_abc' });
    expect(seenAuth).toBe('Bearer tok_123');
    expect(seenBody?.summary).toBe('Order #1042');
    expect(seenBody?.start).toEqual({ dateTime: '2026-03-01T10:00:00+02:00' });
    expect(seenBody?.end).toEqual({ dateTime: '2026-03-01T11:00:00+02:00' });
  });

  it('classifies a 401 as revoked and terminal', async () => {
    server.use(
      http.post('https://www.googleapis.com/calendar/v3/calendars/primary/events', () =>
        HttpResponse.json(
          {
            error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] },
          },
          { status: 401 },
        ),
      ),
    );

    const result = await createGoogleCalendarEvent({
      accessToken: 'tok_123',
      summary: 'x',
      startIso: '2026-03-01T10:00:00+02:00',
      endIso: '2026-03-01T11:00:00+02:00',
      http: http_,
    });

    expect(result).toMatchObject({
      ok: false,
      revoked: true,
      retryable: false,
      errorCode: 'GOOGLE_AUTH_REVOKED',
    });
  });

  it('classifies a rate-limit error as retryable', async () => {
    server.use(
      http.post('https://www.googleapis.com/calendar/v3/calendars/primary/events', () =>
        HttpResponse.json(
          {
            error: {
              code: 403,
              message: 'Rate Limit Exceeded',
              errors: [{ reason: 'rateLimitExceeded' }],
            },
          },
          { status: 403 },
        ),
      ),
    );

    const result = await createGoogleCalendarEvent({
      accessToken: 'tok_123',
      summary: 'x',
      startIso: '2026-03-01T10:00:00+02:00',
      endIso: '2026-03-01T11:00:00+02:00',
      http: http_,
    });

    expect(result).toMatchObject({ ok: false, revoked: false, retryable: true });
  });

  it('classifies a plain 400 as terminal, not revoked', async () => {
    server.use(
      http.post('https://www.googleapis.com/calendar/v3/calendars/primary/events', () =>
        HttpResponse.json({ error: { code: 400, message: 'Bad Request' } }, { status: 400 }),
      ),
    );

    const result = await createGoogleCalendarEvent({
      accessToken: 'tok_123',
      summary: 'x',
      startIso: '2026-03-01T10:00:00+02:00',
      endIso: '2026-03-01T11:00:00+02:00',
      http: http_,
    });

    expect(result).toMatchObject({
      ok: false,
      revoked: false,
      retryable: false,
      errorCode: 'GOOGLE_CALENDAR_400',
    });
  });
});

describe('buildGoogleAuthorizeUrl', () => {
  it('requests offline access with a forced consent prompt and the calendar.events + email scopes', () => {
    const url = new URL(
      buildGoogleAuthorizeUrl({
        clientId: 'client-1',
        redirectUri: 'https://app.example.com/api/oauth/google/callback',
        state: 'opaque-state',
      }),
    );

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://app.example.com/api/oauth/google/callback',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('opaque-state');
    const scopes = url.searchParams.get('scope')?.split(' ') ?? [];
    expect(scopes).toContain('https://www.googleapis.com/auth/calendar.events');
    expect(scopes).toContain('https://www.googleapis.com/auth/userinfo.email');
  });
});

describe('exchangeGoogleAuthCode', () => {
  it('POSTs the authorization code and returns the refresh + access tokens', async () => {
    let seenBody: string | undefined;
    server.use(
      http.post('https://oauth2.googleapis.com/token', async ({ request }) => {
        seenBody = await request.text();
        return HttpResponse.json({
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 3599,
          token_type: 'Bearer',
        });
      }),
    );

    const result = await exchangeGoogleAuthCode({
      clientId: 'client-1',
      clientSecret: 'secret-1',
      code: 'auth-code-1',
      redirectUri: 'https://app.example.com/api/oauth/google/callback',
      http: http_,
    });

    expect(result).toEqual({ ok: true, refreshToken: 'refresh-1', accessToken: 'access-1' });
    const params = new URLSearchParams(seenBody);
    expect(params.get('code')).toBe('auth-code-1');
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('redirect_uri')).toBe('https://app.example.com/api/oauth/google/callback');
  });

  it('reports failure when Google omits the refresh token', async () => {
    server.use(
      http.post('https://oauth2.googleapis.com/token', () =>
        HttpResponse.json({ access_token: 'access-1', expires_in: 3599 }),
      ),
    );

    const result = await exchangeGoogleAuthCode({
      clientId: 'client-1',
      clientSecret: 'secret-1',
      code: 'auth-code-1',
      redirectUri: 'https://app.example.com/api/oauth/google/callback',
      http: http_,
    });

    expect(result).toMatchObject({ ok: false });
  });

  it('reports the error description on a failed exchange', async () => {
    server.use(
      http.post('https://oauth2.googleapis.com/token', () =>
        HttpResponse.json(
          { error: 'invalid_grant', error_description: 'Malformed auth code.' },
          { status: 400 },
        ),
      ),
    );

    const result = await exchangeGoogleAuthCode({
      clientId: 'client-1',
      clientSecret: 'secret-1',
      code: 'bad-code',
      redirectUri: 'https://app.example.com/api/oauth/google/callback',
      http: http_,
    });

    expect(result).toEqual({ ok: false, message: 'Malformed auth code.' });
  });
});

describe('fetchGoogleUserEmail', () => {
  it('returns the account email with a Bearer-authorized GET', async () => {
    let seenAuth: string | null = null;
    server.use(
      http.get('https://www.googleapis.com/oauth2/v2/userinfo', ({ request }) => {
        seenAuth = request.headers.get('authorization');
        return HttpResponse.json({ email: 'owner@example.com', verified_email: true });
      }),
    );

    const result = await fetchGoogleUserEmail({ accessToken: 'access-1', http: http_ });

    expect(result).toEqual({ ok: true, email: 'owner@example.com' });
    expect(seenAuth).toBe('Bearer access-1');
  });

  it('reports failure on a non-2xx response', async () => {
    server.use(
      http.get('https://www.googleapis.com/oauth2/v2/userinfo', () =>
        HttpResponse.json({}, { status: 401 }),
      ),
    );

    const result = await fetchGoogleUserEmail({ accessToken: 'bad-token', http: http_ });

    expect(result).toMatchObject({ ok: false });
  });
});
