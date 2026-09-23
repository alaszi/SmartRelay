import {
  consumeEmailVerifyToken,
  createRelay,
  decryptRelaySecret,
  getRelayInternal,
} from '@smartrelay/db';
import { createSafeHttpClient, hashToken } from '@smartrelay/engine';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, resetDb, TEST_APP_URL, type TestApp } from '../../test/helpers';

const mswServer = setupServer();
beforeAll(() => mswServer.listen({ onUnhandledRequest: 'error' }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

const testHttp = createSafeHttpClient({
  resolver: async () => [{ address: '93.184.216.34', family: 4 }],
});
const GOOGLE = { clientId: 'client-1', clientSecret: 'secret-1' };

let testApp: TestApp;
let cookie: string;
let userId: string;

async function registerAndVerify(email: string): Promise<{ cookie: string; userId: string }> {
  const response = await testApp.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { origin: TEST_APP_URL },
    payload: { email, password: 'hunter22' },
  });
  const sessionCookie = `sr_session=${response.cookies.find((c) => c.name === 'sr_session')!.value}`;
  const { id } = response.json() as { id: string };
  const link = testApp.mailer.sent.at(-1)?.text ?? '';
  const token = new URL(link.split(': ')[1] ?? '', TEST_APP_URL).searchParams.get('token')!;
  await consumeEmailVerifyToken(testApp.ctx.db, hashToken(token));
  return { cookie: sessionCookie, userId: id };
}

beforeEach(async () => {
  testApp = buildTestApp({}, undefined, { google: GOOGLE, http: testHttp });
  await resetDb(testApp.ctx.db);
  ({ cookie, userId } = await registerAndVerify('owner@example.com'));
});
afterEach(async () => {
  await testApp.close();
});

function mockGoogleSuccess(email = 'owner@gmail.com'): void {
  mswServer.use(
    http.post('https://oauth2.googleapis.com/token', () =>
      HttpResponse.json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3599 }),
    ),
    http.get('https://www.googleapis.com/oauth2/v2/userinfo', () =>
      HttpResponse.json({ email, verified_email: true }),
    ),
  );
}

describe('GET /api/oauth/google/start', () => {
  it('redirects to Google with a state param', async () => {
    const response = await testApp.app.inject({
      method: 'GET',
      url: '/api/oauth/google/start',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.origin + location.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(location.searchParams.get('client_id')).toBe('client-1');
    expect(location.searchParams.get('state')).toBeTruthy();
  });

  it('requires authentication', async () => {
    const response = await testApp.app.inject({ method: 'GET', url: '/api/oauth/google/start' });
    expect(response.statusCode).toBe(401);
  });

  it('503s when Google is not configured', async () => {
    const unconfigured = buildTestApp({}, undefined, { http: testHttp });
    await resetDb(unconfigured.ctx.db);
    const { cookie: c } = await (async () => {
      const response = await unconfigured.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        headers: { origin: TEST_APP_URL },
        payload: { email: 'x@example.com', password: 'hunter22' },
      });
      return {
        cookie: `sr_session=${response.cookies.find((cc) => cc.name === 'sr_session')!.value}`,
      };
    })();

    const response = await unconfigured.app.inject({
      method: 'GET',
      url: '/api/oauth/google/start',
      headers: { cookie: c },
    });
    expect(response.statusCode).toBe(503);
    await unconfigured.close();
  });
});

describe('GET /api/oauth/google/callback', () => {
  it('exchanges the code, stores the connection, and redirects to the dashboard', async () => {
    mockGoogleSuccess('owner@gmail.com');
    const start = await testApp.app.inject({
      method: 'GET',
      url: '/api/oauth/google/start',
      headers: { cookie },
    });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;

    const response = await testApp.app.inject({
      method: 'GET',
      url: `/api/oauth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.pathname).toBe('/dashboard');
    expect(location.searchParams.get('connected')).toBe('owner@gmail.com');

    const list = await testApp.app.inject({
      method: 'GET',
      url: '/api/oauth/google/connections',
      headers: { cookie },
    });
    expect(list.json().connections).toMatchObject([{ accountEmail: 'owner@gmail.com' }]);
    expect(JSON.stringify(list.json())).not.toContain('refresh-1');
  });

  it('attaches the connection to the relay named in state and updates its refreshToken', async () => {
    const relay = await createRelay(testApp.ctx.db, testApp.ctx.keyring, {
      userId,
      name: 'Bookings',
      type: 'calendar_bridge',
      configPublic: { titleTemplate: 'x', startPath: '$.a', endPath: '$.b' },
    });

    mockGoogleSuccess('owner@gmail.com');
    const start = await testApp.app.inject({
      method: 'GET',
      url: `/api/oauth/google/start?relayId=${relay.id}`,
      headers: { cookie },
    });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;

    const response = await testApp.app.inject({
      method: 'GET',
      url: `/api/oauth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.pathname).toBe(`/relays/${relay.id}`);

    const stored = await getRelayInternal(testApp.ctx.db, relay.id);
    expect(decryptRelaySecret(testApp.ctx.keyring, stored!)).toMatchObject({
      refreshToken: 'refresh-1',
    });
  });

  it('redirects with googleError when the user denies consent', async () => {
    const response = await testApp.app.inject({
      method: 'GET',
      url: '/api/oauth/google/callback?error=access_denied',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.searchParams.get('googleError')).toBe('access_denied');
  });

  it('rejects a tampered or forged state without calling Google', async () => {
    mswServer.use(http.all('*', () => new Response('should not be called', { status: 500 })));
    const response = await testApp.app.inject({
      method: 'GET',
      url: '/api/oauth/google/callback?code=auth-code&state=not-a-real-state',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.searchParams.get('googleError')).toBe('invalid_state');
  });

  it('rejects a state minted for a different user', async () => {
    mswServer.use(http.all('*', () => new Response('should not be called', { status: 500 })));
    const start = await testApp.app.inject({
      method: 'GET',
      url: '/api/oauth/google/start',
      headers: { cookie },
    });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const { cookie: otherCookie } = await registerAndVerify('other@example.com');

    const response = await testApp.app.inject({
      method: 'GET',
      url: `/api/oauth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
      headers: { cookie: otherCookie },
    });
    const location = new URL(response.headers.location as string);
    expect(location.searchParams.get('googleError')).toBe('invalid_state');
  });
});

describe('POST /api/relays/:id/google-connection', () => {
  it("attaches an existing connection's refresh token to a relay", async () => {
    mockGoogleSuccess('owner@gmail.com');
    const start = await testApp.app.inject({
      method: 'GET',
      url: '/api/oauth/google/start',
      headers: { cookie },
    });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    await testApp.app.inject({
      method: 'GET',
      url: `/api/oauth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
      headers: { cookie },
    });
    const connectionId = (
      await testApp.app.inject({
        method: 'GET',
        url: '/api/oauth/google/connections',
        headers: { cookie },
      })
    ).json().connections[0].id as string;

    const relay = await createRelay(testApp.ctx.db, testApp.ctx.keyring, {
      userId,
      name: 'Bookings',
      type: 'calendar_bridge',
      configPublic: { titleTemplate: 'x', startPath: '$.a', endPath: '$.b' },
    });

    const response = await testApp.app.inject({
      method: 'POST',
      url: `/api/relays/${relay.id}/google-connection`,
      headers: { cookie, origin: TEST_APP_URL },
      payload: { connectionId },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accountEmail: 'owner@gmail.com' });
    const stored = await getRelayInternal(testApp.ctx.db, relay.id);
    expect(decryptRelaySecret(testApp.ctx.keyring, stored!)).toMatchObject({
      refreshToken: 'refresh-1',
    });
  });

  it('404s for a connection owned by someone else', async () => {
    mockGoogleSuccess('owner@gmail.com');
    const start = await testApp.app.inject({
      method: 'GET',
      url: '/api/oauth/google/start',
      headers: { cookie },
    });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    await testApp.app.inject({
      method: 'GET',
      url: `/api/oauth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
      headers: { cookie },
    });
    const connectionId = (
      await testApp.app.inject({
        method: 'GET',
        url: '/api/oauth/google/connections',
        headers: { cookie },
      })
    ).json().connections[0].id as string;

    const { cookie: otherCookie, userId: otherUserId } =
      await registerAndVerify('stranger@example.com');
    const relay = await createRelay(testApp.ctx.db, testApp.ctx.keyring, {
      userId: otherUserId,
      name: 'Bookings',
      type: 'calendar_bridge',
      configPublic: { titleTemplate: 'x', startPath: '$.a', endPath: '$.b' },
    });

    const response = await testApp.app.inject({
      method: 'POST',
      url: `/api/relays/${relay.id}/google-connection`,
      headers: { cookie: otherCookie, origin: TEST_APP_URL },
      payload: { connectionId },
    });
    expect(response.statusCode).toBe(404);
  });
});
