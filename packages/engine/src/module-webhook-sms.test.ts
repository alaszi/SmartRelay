import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSafeHttpClient } from './safe-http';
import { webhookSmsModule, type WebhookSmsConfig } from './module-webhook-sms';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const http_ = createSafeHttpClient({
  resolver: async () => [{ address: '93.184.216.34', family: 4 }],
});
const ctx = {
  eventId: 'evt_1',
  userTimezone: 'Europe/Bucharest',
  http: http_,
  now: new Date('2026-01-01T00:00:00Z'),
};

const twilioConfig: WebhookSmsConfig = {
  provider: 'twilio',
  accountSid: 'AC123',
  authToken: 'tok123',
  from: '+15551234567',
  recipientPath: '$.customer.phone',
  template: 'Hi {{$.customer.name}}, your order shipped!',
};

const smsLinkConfig: WebhookSmsConfig = {
  provider: 'smslink',
  connectionId: 'conn1',
  password: 'pw1',
  recipientPath: '$.customer.phone',
  template: 'Hi {{$.customer.name}}!',
};

describe('webhookSmsModule contract', () => {
  it('always prices as sms_dispatch, regardless of provider', () => {
    expect(webhookSmsModule.priceKind(twilioConfig)).toBe('sms_dispatch');
    expect(webhookSmsModule.priceKind(smsLinkConfig)).toBe('sms_dispatch');
  });

  it('validates each provider variant and rejects an unknown provider', () => {
    expect(webhookSmsModule.configSchema.safeParse(twilioConfig).success).toBe(true);
    expect(webhookSmsModule.configSchema.safeParse(smsLinkConfig).success).toBe(true);
    expect(webhookSmsModule.configSchema.safeParse({ provider: 'unknown' }).success).toBe(false);
    expect(
      webhookSmsModule.configSchema.safeParse({ provider: 'twilio', accountSid: 'x' }).success,
    ).toBe(false); // missing authToken/from/recipientPath/template
  });

  it('sampleInput matches the default recipientPath used in these tests', () => {
    const sample = webhookSmsModule.sampleInput() as { customer: { phone: string } };
    expect(sample.customer.phone).toBeTruthy();
  });
});

describe('webhookSmsModule.execute: happy path', () => {
  it('normalizes the phone, renders the template, sends via Twilio, and reports segments', async () => {
    let seenBody: string | undefined;
    server.use(
      http.post(
        'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json',
        async ({ request }) => {
          seenBody = await request.text();
          return HttpResponse.json({ sid: 'SM1' }, { status: 201 });
        },
      ),
    );

    const result = await webhookSmsModule.execute({
      config: twilioConfig,
      payload: { customer: { name: 'Ana', phone: '0722 123 456' } },
      ctx,
    });

    expect(result).toMatchObject({
      ok: true,
      statusCode: 201,
      extra: { providerMessageId: 'SM1', segments: 1, encoding: 'GSM-7' },
    });
    const params = new URLSearchParams(seenBody);
    expect(params.get('To')).toBe('+40722123456');
    expect(params.get('Body')).toBe('Hi Ana, your order shipped!');
  });

  it('works the same way through SMSLink', async () => {
    server.use(
      http.get('https://secure.smslink.ro/sms/gateway/communicate/index.php', ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('to')).toBe('+40722123456');
        return HttpResponse.text('OK');
      }),
    );

    const result = await webhookSmsModule.execute({
      config: smsLinkConfig,
      payload: { customer: { name: 'Ana', phone: '0722123456' } },
      ctx,
    });

    expect(result).toMatchObject({ ok: true });
  });
});

describe('webhookSmsModule.execute: terminal failures (no network call for the first two)', () => {
  it('reports RECIPIENT_PATH_MISSING without calling the provider', async () => {
    server.use(http.all('*', () => new Response('should not be called', { status: 500 })));

    const result = await webhookSmsModule.execute({
      config: twilioConfig,
      payload: { customer: { name: 'Ana' } }, // no phone
      ctx,
    });

    expect(result).toMatchObject({
      ok: false,
      retryable: false,
      errorCode: 'RECIPIENT_PATH_MISSING',
    });
  });

  it('reports INVALID_PHONE for an unparsable number without calling the provider', async () => {
    server.use(http.all('*', () => new Response('should not be called', { status: 500 })));

    const result = await webhookSmsModule.execute({
      config: twilioConfig,
      payload: { customer: { name: 'Ana', phone: 'not-a-number' } },
      ctx,
    });

    expect(result).toMatchObject({ ok: false, retryable: false, errorCode: 'INVALID_PHONE' });
  });

  it('reports TEMPLATE_VAR_MISSING for a template variable absent from the payload', async () => {
    server.use(http.all('*', () => new Response('should not be called', { status: 500 })));

    const result = await webhookSmsModule.execute({
      config: { ...twilioConfig, template: 'Hi {{$.customer.nickname}}' },
      payload: { customer: { name: 'Ana', phone: '0722123456' } },
      ctx,
    });

    expect(result).toMatchObject({
      ok: false,
      retryable: false,
      errorCode: 'TEMPLATE_VAR_MISSING',
    });
  });

  it('propagates a terminal provider error (e.g. Twilio 400)', async () => {
    server.use(
      http.post('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json', () =>
        HttpResponse.json({ code: 21211, message: 'Invalid number' }, { status: 400 }),
      ),
    );

    const result = await webhookSmsModule.execute({
      config: twilioConfig,
      payload: { customer: { name: 'Ana', phone: '0722123456' } },
      ctx,
    });

    expect(result).toMatchObject({ ok: false, retryable: false, errorCode: 'TWILIO_21211' });
  });
});

describe('webhookSmsModule.execute: retryable failures', () => {
  it('propagates a retryable provider error (e.g. Twilio 503)', async () => {
    server.use(
      http.post('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json', () =>
        HttpResponse.json({ message: 'down' }, { status: 503 }),
      ),
    );

    const result = await webhookSmsModule.execute({
      config: twilioConfig,
      payload: { customer: { name: 'Ana', phone: '0722123456' } },
      ctx,
    });

    expect(result).toMatchObject({ ok: false, retryable: true });
  });
});

describe('webhookSmsModule.execute: Infobip (typed stub)', () => {
  it('reports PROVIDER_NOT_IMPLEMENTED without making a network call', async () => {
    server.use(http.all('*', () => new Response('should not be called', { status: 500 })));

    const result = await webhookSmsModule.execute({
      config: {
        provider: 'infobip',
        apiKey: 'x',
        baseUrl: 'https://api.infobip.com',
        recipientPath: '$.customer.phone',
        template: 'Hi {{$.customer.name}}',
      },
      payload: { customer: { name: 'Ana', phone: '0722123456' } },
      ctx,
    });

    expect(result).toMatchObject({
      ok: false,
      retryable: false,
      errorCode: 'PROVIDER_NOT_IMPLEMENTED',
    });
  });
});
