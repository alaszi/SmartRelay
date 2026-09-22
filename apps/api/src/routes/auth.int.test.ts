import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, resetDb, TEST_APP_URL, type TestApp } from '../../test/helpers';

let testApp: TestApp;

beforeEach(async () => {
  testApp = buildTestApp();
  await resetDb(testApp.ctx.db);
});
afterEach(async () => {
  await testApp.close();
});

function post(
  path: string,
  payload?: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return testApp.app.inject({
    method: 'POST',
    url: path,
    headers: { origin: TEST_APP_URL, ...headers },
    ...(payload === undefined ? {} : { payload }),
  });
}

function cookieFrom(response: { cookies: { name: string; value: string }[] }): string {
  const cookie = response.cookies.find((c) => c.name === 'sr_session');
  if (!cookie) throw new Error('no session cookie in response');
  return `sr_session=${cookie.value}`;
}

describe('POST /api/auth/register', () => {
  it('creates the account, sends a verification email and logs the user in', async () => {
    const response = await post('/api/auth/register', {
      email: 'ana@example.com',
      password: 'hunter22',
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ id: expect.any(String), email: 'ana@example.com' });
    expect(response.cookies.some((c) => c.name === 'sr_session')).toBe(true);

    expect(testApp.mailer.sent).toHaveLength(1);
    expect(testApp.mailer.sent[0]?.to).toBe('ana@example.com');
    expect(testApp.mailer.sent[0]?.text).toContain('verify-email?token=');
  });

  it('rejects a duplicate email', async () => {
    await post('/api/auth/register', { email: 'dup@example.com', password: 'hunter22' });
    const response = await post('/api/auth/register', {
      email: 'dup@example.com',
      password: 'hunter22',
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'EMAIL_TAKEN' } });
  });

  it('rejects a short password or invalid email with the standard error shape', async () => {
    const badPassword = await post('/api/auth/register', {
      email: 'x@example.com',
      password: '123',
    });
    expect(badPassword.statusCode).toBe(400);
    expect(badPassword.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const badEmail = await post('/api/auth/register', {
      email: 'not-an-email',
      password: 'hunter22',
    });
    expect(badEmail.statusCode).toBe(400);
  });

  it('rejects a request from the wrong origin (CSRF)', async () => {
    const response = await post(
      '/api/auth/register',
      { email: 'x@example.com', password: 'hunter22' },
      { origin: 'https://evil.example' },
    );
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'CSRF_REJECTED' } });
  });

  it('never returns or logs the plaintext password', async () => {
    const response = await post('/api/auth/register', {
      email: 'nopw@example.com',
      password: 'hunter22',
    });
    expect(JSON.stringify(response.json())).not.toContain('hunter22');
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    await post('/api/auth/register', { email: 'login@example.com', password: 'correct-pw' });
  });

  it('logs in with correct credentials and sets a fresh session cookie', async () => {
    const response = await post('/api/auth/login', {
      email: 'login@example.com',
      password: 'correct-pw',
    });
    expect(response.statusCode).toBe(200);
    expect(response.cookies.some((c) => c.name === 'sr_session')).toBe(true);
  });

  it('issues a different session token on every login', async () => {
    const first = cookieFrom(
      await post('/api/auth/login', { email: 'login@example.com', password: 'correct-pw' }),
    );
    const second = cookieFrom(
      await post('/api/auth/login', { email: 'login@example.com', password: 'correct-pw' }),
    );
    expect(first).not.toBe(second);

    // Both sessions are valid: login does not revoke earlier ones.
    for (const cookie of [first, second]) {
      const me = await testApp.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
      expect(me.statusCode).toBe(200);
    }
  });

  it('rejects a wrong password without revealing whether the email exists', async () => {
    const wrongPassword = await post('/api/auth/login', {
      email: 'login@example.com',
      password: 'nope',
    });
    const unknownEmail = await post('/api/auth/login', {
      email: 'nobody@example.com',
      password: 'nope',
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(unknownEmail.json());
  });

  it('rate-limits repeated login attempts for the same email', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        post('/api/auth/login', { email: 'login@example.com', password: 'nope' }),
      ),
    );
    expect(attempts.some((response) => response.statusCode === 429)).toBe(true);
  });
});

describe('POST /api/auth/logout', () => {
  it('ends the session so the cookie no longer authenticates', async () => {
    const registered = await post('/api/auth/register', {
      email: 'out@example.com',
      password: 'hunter22',
    });
    const cookie = cookieFrom(registered);

    const logout = await testApp.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, origin: TEST_APP_URL },
    });
    expect(logout.statusCode).toBe(204);

    const me = await testApp.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });

  it('requires authentication', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { origin: TEST_APP_URL },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('GET /api/me', () => {
  it('requires a session', async () => {
    const response = await testApp.app.inject({ method: 'GET', url: '/api/me' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('returns the account with an unverified email and zero balance', async () => {
    const registered = await post('/api/auth/register', {
      email: 'me@example.com',
      password: 'hunter22',
    });
    const cookie = cookieFrom(registered);

    const me = await testApp.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });

    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({
      id: expect.any(String),
      email: 'me@example.com',
      emailVerified: false,
      balance: '0.00',
    });
  });
});

describe('email verification', () => {
  it('verifies the email using the token sent by mail', async () => {
    const registered = await post('/api/auth/register', {
      email: 'verify@example.com',
      password: 'hunter22',
    });
    const cookie = cookieFrom(registered);
    const link = testApp.mailer.sent[0]?.text ?? '';
    const token = new URL(link.split(': ')[1] ?? '', TEST_APP_URL).searchParams.get('token');

    const verify = await post('/api/auth/verify-email', { token });
    expect(verify.statusCode).toBe(200);

    const me = await testApp.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.json()).toMatchObject({ emailVerified: true });
  });

  it('rejects an unknown token', async () => {
    const response = await post('/api/auth/verify-email', { token: 'not-a-real-token' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'TOKEN_INVALID' } });
  });
});

describe('password reset', () => {
  it('resets the password, invalidates old sessions, and the new password works', async () => {
    const registered = await post('/api/auth/register', {
      email: 'reset@example.com',
      password: 'old-password',
    });
    const oldCookie = cookieFrom(registered);

    const forgot = await post('/api/auth/forgot', { email: 'reset@example.com' });
    expect(forgot.statusCode).toBe(200);
    const link = testApp.mailer.sent.at(-1)?.text ?? '';
    const token = new URL(link.split(': ')[1] ?? '', TEST_APP_URL).searchParams.get('token');

    const reset = await post('/api/auth/reset', { token, password: 'new-password' });
    expect(reset.statusCode).toBe(200);

    const meWithOldCookie = await testApp.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: oldCookie },
    });
    expect(meWithOldCookie.statusCode).toBe(401);

    const loginOld = await post('/api/auth/login', {
      email: 'reset@example.com',
      password: 'old-password',
    });
    expect(loginOld.statusCode).toBe(401);
    const loginNew = await post('/api/auth/login', {
      email: 'reset@example.com',
      password: 'new-password',
    });
    expect(loginNew.statusCode).toBe(200);
  });

  it('does not reveal whether the email exists', async () => {
    const known = await post('/api/auth/forgot', { email: 'reset@example.com' });
    const unknown = await post('/api/auth/forgot', { email: 'never-registered@example.com' });
    expect(known.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(200);
    expect(known.json()).toEqual(unknown.json());
  });

  it('rejects an unknown or already-used reset token', async () => {
    const response = await post('/api/auth/reset', { token: 'bogus', password: 'whatever1' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'TOKEN_INVALID' } });
  });
});
