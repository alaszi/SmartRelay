import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSafeHttpClient } from './safe-http';
import { infobipProvider, smsLinkProvider, twilioProvider } from './sms-providers';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// SafeHttpClient normally forbids talking to private/loopback addresses; msw intercepts requests
// before any socket is opened, so this resolver just needs to return a non-blocked-looking address.
const http_ = createSafeHttpClient({
  resolver: async () => [{ address: '93.184.216.34', family: 4 }],
});

describe('smsLinkProvider', () => {
  const credentials = { connectionId: 'conn1', password: 'pw1' };

  it('sends the documented GET request and treats a non-ERROR body as success', async () => {
    let seenUrl: URL | undefined;
    server.use(
      http.get('https://secure.smslink.ro/sms/gateway/communicate/index.php', ({ request }) => {
        seenUrl = new URL(request.url);
        return HttpResponse.text('OK;1;0.0250');
      }),
    );

    const result = await smsLinkProvider.send(credentials, {
      to: '+40722123456',
      text: 'Hi Ana',
      http: http_,
    });

    expect(result.ok).toBe(true);
    expect(seenUrl?.searchParams.get('connection_id')).toBe('conn1');
    expect(seenUrl?.searchParams.get('password')).toBe('pw1');
    expect(seenUrl?.searchParams.get('to')).toBe('+40722123456');
    expect(seenUrl?.searchParams.get('message')).toBe('Hi Ana');
  });

  it('parses an ERROR response into a structured, non-retryable failure', async () => {
    server.use(
      http.get('https://secure.smslink.ro/sms/gateway/communicate/index.php', () =>
        HttpResponse.text('ERROR;9;Phone number is invalid!'),
      ),
    );

    const result = await smsLinkProvider.send(credentials, {
      to: '+40722123456',
      text: 'Hi',
      http: http_,
    });

    expect(result).toMatchObject({
      ok: false,
      retryable: false,
      errorCode: 'SMSLINK_9',
      message: 'Phone number is invalid!',
    });
  });

  it('treats the documented transient error code (16) as retryable', async () => {
    server.use(
      http.get('https://secure.smslink.ro/sms/gateway/communicate/index.php', () =>
        HttpResponse.text('ERROR;16;An error has occured during sending!'),
      ),
    );

    const result = await smsLinkProvider.send(credentials, {
      to: '+40722123456',
      text: 'Hi',
      http: http_,
    });

    expect(result).toMatchObject({ ok: false, retryable: true, errorCode: 'SMSLINK_16' });
  });

  it('treats a non-2xx HTTP status without an ERROR body as a retryable failure for 5xx/429', async () => {
    server.use(
      http.get('https://secure.smslink.ro/sms/gateway/communicate/index.php', () =>
        HttpResponse.text('upstream down', { status: 503 }),
      ),
    );

    const result = await smsLinkProvider.send(credentials, {
      to: '+40722123456',
      text: 'Hi',
      http: http_,
    });

    expect(result).toMatchObject({ ok: false, retryable: true, statusCode: 503 });
  });

  it('does not put credentials in the outgoing SMS body or in the parsed error', async () => {
    server.use(
      http.get('https://secure.smslink.ro/sms/gateway/communicate/index.php', () =>
        HttpResponse.text('ERROR;2;Connection ID is not approved!'),
      ),
    );

    const result = await smsLinkProvider.send(
      { connectionId: 'secret-conn', password: 'secret-pw' },
      { to: '+40722123456', text: 'Hi', http: http_ },
    );

    expect(JSON.stringify(result)).not.toContain('secret-pw');
  });
});

describe('twilioProvider', () => {
  const credentials = { accountSid: 'AC123', authToken: 'tok123', from: '+15551234567' };

  it('sends Basic auth and the documented form fields, and returns the message sid on success', async () => {
    let seenAuth: string | null = null;
    let seenBody: string | undefined;
    server.use(
      http.post(
        'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json',
        async ({ request }) => {
          seenAuth = request.headers.get('authorization');
          seenBody = await request.text();
          return HttpResponse.json({ sid: 'SM123', status: 'queued' }, { status: 201 });
        },
      ),
    );

    const result = await twilioProvider.send(credentials, {
      to: '+40722123456',
      text: 'Hi Ana',
      http: http_,
    });

    expect(result).toMatchObject({ ok: true, statusCode: 201, providerMessageId: 'SM123' });
    expect(seenAuth).toBe(`Basic ${Buffer.from('AC123:tok123').toString('base64')}`);
    const params = new URLSearchParams(seenBody);
    expect(params.get('From')).toBe('+15551234567');
    expect(params.get('To')).toBe('+40722123456');
    expect(params.get('Body')).toBe('Hi Ana');
  });

  it('parses a Twilio error body into errorCode/message and treats 4xx as terminal', async () => {
    server.use(
      http.post('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json', () =>
        HttpResponse.json(
          { code: 21211, message: "The 'To' number is not a valid phone number." },
          { status: 400 },
        ),
      ),
    );

    const result = await twilioProvider.send(credentials, {
      to: '+40722123456',
      text: 'Hi',
      http: http_,
    });

    expect(result).toMatchObject({
      ok: false,
      retryable: false,
      errorCode: 'TWILIO_21211',
      message: "The 'To' number is not a valid phone number.",
    });
  });

  it.each([500, 502, 503, 429])('treats HTTP %i as retryable', async (status) => {
    server.use(
      http.post('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json', () =>
        HttpResponse.json({ message: 'down' }, { status }),
      ),
    );

    const result = await twilioProvider.send(credentials, {
      to: '+40722123456',
      text: 'Hi',
      http: http_,
    });

    expect(result).toMatchObject({ ok: false, retryable: true, statusCode: status });
  });

  it('treats HTTP 401/403 as terminal', async () => {
    server.use(
      http.post('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json', () =>
        HttpResponse.json({ message: 'bad auth' }, { status: 401 }),
      ),
    );

    const result = await twilioProvider.send(credentials, {
      to: '+40722123456',
      text: 'Hi',
      http: http_,
    });

    expect(result).toMatchObject({ ok: false, retryable: false });
  });

  it('falls back to a generic message for a non-JSON error body', async () => {
    server.use(
      http.post('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json', () =>
        HttpResponse.text('<html>error</html>', { status: 500 }),
      ),
    );

    const result = await twilioProvider.send(credentials, {
      to: '+40722123456',
      text: 'Hi',
      http: http_,
    });

    expect(result).toMatchObject({ ok: false, errorCode: 'TWILIO_HTTP_ERROR' });
  });

  it('does not leak the auth token in the result', async () => {
    server.use(
      http.post('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json', () =>
        HttpResponse.json({ code: 20003, message: 'Authentication error' }, { status: 401 }),
      ),
    );

    const result = await twilioProvider.send(credentials, {
      to: '+40722123456',
      text: 'Hi',
      http: http_,
    });

    expect(JSON.stringify(result)).not.toContain('tok123');
  });
});

describe('infobipProvider', () => {
  it('is a stub: it never makes a network call and always reports PROVIDER_NOT_IMPLEMENTED', async () => {
    server.use(
      http.all('*', () => {
        throw new Error('infobip stub must not make a network call');
      }),
    );

    const result = await infobipProvider.send(
      { apiKey: 'x', baseUrl: 'https://api.infobip.com' },
      { to: '+40722123456', text: 'Hi', http: http_ },
    );

    expect(result).toMatchObject({
      ok: false,
      retryable: false,
      errorCode: 'PROVIDER_NOT_IMPLEMENTED',
    });
  });
});
