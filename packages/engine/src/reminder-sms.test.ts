import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sendReminderSms } from './reminder-sms';
import { createSafeHttpClient } from './safe-http';
import type { ReminderConfig } from './module-calendar-bridge';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const http_ = createSafeHttpClient({
  resolver: async () => [{ address: '93.184.216.34', family: 4 }],
});

const twilioConfig: Extract<ReminderConfig, { reminderMode: 'twilio' }> = {
  reminderMode: 'twilio',
  reminderOffsetMinutes: 120,
  reminderRecipientPath: '$.customer.phone',
  reminderTemplate: 'Reminder: your appointment is in 2h, {{$.customer.name}}',
  reminderAccountSid: 'AC123',
  reminderFrom: '+15551234567',
  reminderSecret: 'tok123',
};

const smsLinkConfig: Extract<ReminderConfig, { reminderMode: 'smslink' }> = {
  reminderMode: 'smslink',
  reminderOffsetMinutes: 60,
  reminderRecipientPath: '$.customer.phone',
  reminderTemplate: 'Reminder: appointment soon',
  reminderConnectionId: 'conn1',
  reminderSecret: 'pw1',
};

describe('sendReminderSms: happy path', () => {
  it('normalizes the phone, renders the template, and sends via Twilio', async () => {
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

    const result = await sendReminderSms(
      twilioConfig,
      { customer: { name: 'Ana', phone: '0722 123 456' } },
      http_,
    );

    expect(result).toMatchObject({
      ok: true,
      statusCode: 201,
      extra: { providerMessageId: 'SM1' },
    });
    const params = new URLSearchParams(seenBody);
    expect(params.get('To')).toBe('+40722123456');
    expect(params.get('Body')).toBe('Reminder: your appointment is in 2h, Ana');
  });

  it('works the same way through SMSLink', async () => {
    server.use(
      http.get('https://secure.smslink.ro/sms/gateway/communicate/index.php', ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get('to')).toBe('+40722123456');
        return HttpResponse.text('OK');
      }),
    );

    const result = await sendReminderSms(
      smsLinkConfig,
      { customer: { name: 'Ana', phone: '0722123456' } },
      http_,
    );

    expect(result).toMatchObject({ ok: true });
  });
});

describe('sendReminderSms: terminal failures (no network call)', () => {
  it('reports RECIPIENT_PATH_MISSING without calling the provider', async () => {
    const result = await sendReminderSms(twilioConfig, { customer: {} }, http_);
    expect(result).toMatchObject({
      ok: false,
      retryable: false,
      errorCode: 'RECIPIENT_PATH_MISSING',
    });
  });

  it('reports an invalid-phone error without calling the provider', async () => {
    const result = await sendReminderSms(
      twilioConfig,
      { customer: { name: 'Ana', phone: 'not-a-phone' } },
      http_,
    );
    expect(result).toMatchObject({ ok: false, retryable: false });
  });

  it('reports a template error without calling the provider', async () => {
    const result = await sendReminderSms(
      { ...twilioConfig, reminderTemplate: '{{$.missing.path}}' },
      { customer: { phone: '0722123456' } },
      http_,
    );
    expect(result).toMatchObject({ ok: false, retryable: false });
  });

  it('propagates a terminal provider error (Twilio 400)', async () => {
    server.use(
      http.post('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json', () =>
        HttpResponse.json({ message: 'Invalid number' }, { status: 400 }),
      ),
    );
    const result = await sendReminderSms(
      twilioConfig,
      { customer: { name: 'Ana', phone: '0722123456' } },
      http_,
    );
    expect(result).toMatchObject({ ok: false, retryable: false, statusCode: 400 });
  });
});

describe('sendReminderSms: retryable failures', () => {
  it('propagates a retryable provider error (Twilio 503)', async () => {
    server.use(
      http.post('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json', () =>
        HttpResponse.json({ message: 'down' }, { status: 503 }),
      ),
    );
    const result = await sendReminderSms(
      twilioConfig,
      { customer: { name: 'Ana', phone: '0722123456' } },
      http_,
    );
    expect(result).toMatchObject({ ok: false, retryable: true, statusCode: 503 });
  });
});
