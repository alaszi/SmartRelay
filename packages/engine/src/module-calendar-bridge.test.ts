import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { calendarBridgeModule, type CalendarBridgeConfig } from './module-calendar-bridge';
import { createSafeHttpClient } from './safe-http';
import type { ModuleContext } from './module';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const http_ = createSafeHttpClient({
  resolver: async () => [{ address: '93.184.216.34', family: 4 }],
});

function baseCtx(overrides: Partial<ModuleContext> = {}): ModuleContext {
  return {
    eventId: 'evt_1',
    userTimezone: 'Europe/Bucharest',
    http: http_,
    now: new Date('2026-01-01T00:00:00Z'),
    google: { clientId: 'client-1', clientSecret: 'secret-1' },
    ...overrides,
  };
}

const config: CalendarBridgeConfig = {
  titleTemplate: 'Booking: {{$.customer.name}}',
  startPath: '$.booking.start',
  endPath: '$.booking.end',
  refreshToken: 'refresh-1',
  reminderMode: 'off',
};

describe('calendarBridgeModule contract', () => {
  it('always prices as calendar_event', () => {
    expect(calendarBridgeModule.priceKind(config)).toBe('calendar_event');
  });

  it('validates the required fields', () => {
    expect(calendarBridgeModule.configSchema.safeParse(config).success).toBe(true);
    expect(calendarBridgeModule.configSchema.safeParse({ ...config, startPath: '' }).success).toBe(
      false,
    );
    expect(
      calendarBridgeModule.configSchema.safeParse({ ...config, refreshToken: '' }).success,
    ).toBe(false);
  });
});

describe('calendarBridgeModule contract: reminder (Advanced)', () => {
  it('accepts reminderMode "off" with no other reminder fields', () => {
    expect(calendarBridgeModule.configSchema.safeParse(config).success).toBe(true);
  });

  it('defaults to off when reminderMode is entirely absent (relays saved before this feature existed)', () => {
    const { reminderMode: _reminderMode, ...withoutReminderMode } = config;
    const parsed = calendarBridgeModule.configSchema.safeParse(withoutReminderMode);
    expect(parsed).toMatchObject({ success: true, data: { reminderMode: 'off' } });
  });

  it('accepts each SMS provider variant when enabled, with its own required fields', () => {
    expect(
      calendarBridgeModule.configSchema.safeParse({
        ...config,
        reminderMode: 'smslink',
        reminderOffsetMinutes: 60,
        reminderRecipientPath: '$.customer.phone',
        reminderTemplate: 'Reminder soon',
        reminderConnectionId: 'conn1',
        reminderSecret: 'pw1',
      }).success,
    ).toBe(true);

    expect(
      calendarBridgeModule.configSchema.safeParse({
        ...config,
        reminderMode: 'twilio',
        reminderOffsetMinutes: 120,
        reminderRecipientPath: '$.customer.phone',
        reminderTemplate: 'Reminder soon',
        reminderAccountSid: 'AC1',
        reminderFrom: '+15551234567',
        reminderSecret: 'tok1',
      }).success,
    ).toBe(true);

    expect(
      calendarBridgeModule.configSchema.safeParse({
        ...config,
        reminderMode: 'infobip',
        reminderOffsetMinutes: 30,
        reminderRecipientPath: '$.customer.phone',
        reminderTemplate: 'Reminder soon',
        reminderBaseUrl: 'https://api.infobip.example',
        reminderSecret: 'key1',
      }).success,
    ).toBe(true);
  });

  it('rejects an enabled reminder missing a provider-specific field', () => {
    expect(
      calendarBridgeModule.configSchema.safeParse({
        ...config,
        reminderMode: 'twilio',
        reminderOffsetMinutes: 120,
        reminderRecipientPath: '$.customer.phone',
        reminderTemplate: 'Reminder soon',
        reminderAccountSid: 'AC1',
        // reminderFrom and reminderSecret missing
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown reminderMode', () => {
    expect(
      calendarBridgeModule.configSchema.safeParse({ ...config, reminderMode: 'carrier-pigeon' })
        .success,
    ).toBe(false);
  });
});

describe('calendarBridgeModule.execute', () => {
  it('creates the event using an offset timestamp as-is', async () => {
    let seenBody:
      { summary?: string; start?: { dateTime?: string }; end?: { dateTime?: string } } | undefined;
    server.use(
      http.post('https://oauth2.googleapis.com/token', () =>
        HttpResponse.json({ access_token: 'tok_123' }),
      ),
      http.post(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        async ({ request }) => {
          seenBody = (await request.json()) as typeof seenBody;
          return HttpResponse.json({ id: 'evt_abc' });
        },
      ),
    );

    const result = await calendarBridgeModule.execute({
      config,
      payload: {
        customer: { name: 'Ana' },
        booking: { start: '2026-03-01T10:00:00+02:00', end: '2026-03-01T11:00:00+02:00' },
      },
      ctx: baseCtx(),
    });

    expect(result).toMatchObject({
      ok: true,
      extra: { googleEventId: 'evt_abc', startIso: '2026-03-01T10:00:00.000+02:00' },
    });
    expect(seenBody?.summary).toBe('Booking: Ana');
    expect(seenBody?.start?.dateTime).toBe('2026-03-01T10:00:00.000+02:00');
    expect(seenBody?.end?.dateTime).toBe('2026-03-01T11:00:00.000+02:00');
  });

  it('interprets an offset-less timestamp in the account timezone', async () => {
    let seenBody: { start?: { dateTime?: string } } | undefined;
    server.use(
      http.post('https://oauth2.googleapis.com/token', () =>
        HttpResponse.json({ access_token: 'tok_123' }),
      ),
      http.post(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        async ({ request }) => {
          seenBody = (await request.json()) as typeof seenBody;
          return HttpResponse.json({ id: 'evt_abc' });
        },
      ),
    );

    const result = await calendarBridgeModule.execute({
      config,
      payload: {
        customer: { name: 'Ana' },
        booking: { start: '2026-03-01T10:00:00', end: '2026-03-01T11:00:00' },
      },
      ctx: baseCtx(),
    });

    expect(result).toMatchObject({ ok: true });
    // Europe/Bucharest is EET (UTC+2) on 2026-03-01 (before the DST switch).
    expect(seenBody?.start?.dateTime).toBe('2026-03-01T10:00:00.000+02:00');
  });

  it('reports TEMPLATE_VAR_MISSING for the title template without calling Google', async () => {
    server.use(http.all('*', () => new Response('should not be called', { status: 500 })));

    const result = await calendarBridgeModule.execute({
      config: { ...config, titleTemplate: '{{$.missing}}' },
      payload: {
        booking: { start: '2026-03-01T10:00:00+02:00', end: '2026-03-01T11:00:00+02:00' },
      },
      ctx: baseCtx(),
    });

    expect(result).toMatchObject({
      ok: false,
      retryable: false,
      errorCode: 'TEMPLATE_VAR_MISSING',
    });
  });

  it('reports START_PATH_MISSING when startPath does not match, without calling Google', async () => {
    server.use(http.all('*', () => new Response('should not be called', { status: 500 })));

    const result = await calendarBridgeModule.execute({
      config,
      payload: { customer: { name: 'Ana' }, booking: { end: '2026-03-01T11:00:00+02:00' } },
      ctx: baseCtx(),
    });

    expect(result).toMatchObject({ ok: false, retryable: false, errorCode: 'START_PATH_MISSING' });
  });

  it('reports INVALID_START_TIME for an unparsable timestamp', async () => {
    server.use(http.all('*', () => new Response('should not be called', { status: 500 })));

    const result = await calendarBridgeModule.execute({
      config,
      payload: {
        customer: { name: 'Ana' },
        booking: { start: 'not-a-date', end: '2026-03-01T11:00:00+02:00' },
      },
      ctx: baseCtx(),
    });

    expect(result).toMatchObject({ ok: false, retryable: false, errorCode: 'INVALID_START_TIME' });
    // MASTER_PLAN section 7: no payload content in app logs. This message reaches
    // delivery_attempts.error_message and the worker's unredacted stderr, so the invalid payload
    // value itself must never appear in it — only which JSONPath produced it.
    expect((result as { message: string }).message).not.toContain('not-a-date');
  });

  it('reports INVALID_TIME_RANGE when end <= start, without calling Google', async () => {
    server.use(http.all('*', () => new Response('should not be called', { status: 500 })));

    const result = await calendarBridgeModule.execute({
      config,
      payload: {
        customer: { name: 'Ana' },
        booking: { start: '2026-03-01T11:00:00+02:00', end: '2026-03-01T11:00:00+02:00' },
      },
      ctx: baseCtx(),
    });

    expect(result).toMatchObject({ ok: false, retryable: false, errorCode: 'INVALID_TIME_RANGE' });
  });

  it('reports GOOGLE_OAUTH_NOT_CONFIGURED when ctx.google is absent, without calling Google', async () => {
    server.use(http.all('*', () => new Response('should not be called', { status: 500 })));

    const result = await calendarBridgeModule.execute({
      config,
      payload: {
        customer: { name: 'Ana' },
        booking: { start: '2026-03-01T10:00:00+02:00', end: '2026-03-01T11:00:00+02:00' },
      },
      ctx: {
        eventId: 'evt_1',
        userTimezone: 'Europe/Bucharest',
        http: http_,
        now: new Date('2026-01-01T00:00:00Z'),
      },
    });

    expect(result).toMatchObject({
      ok: false,
      retryable: false,
      errorCode: 'GOOGLE_OAUTH_NOT_CONFIGURED',
    });
  });

  it('reports a terminal GOOGLE_AUTH_REVOKED on invalid_grant, without calling the Calendar API', async () => {
    server.use(
      http.post('https://oauth2.googleapis.com/token', () =>
        HttpResponse.json({ error: 'invalid_grant' }, { status: 400 }),
      ),
      http.post('https://www.googleapis.com/calendar/v3/calendars/primary/events', () => {
        throw new Error('should not be called');
      }),
    );

    const result = await calendarBridgeModule.execute({
      config,
      payload: {
        customer: { name: 'Ana' },
        booking: { start: '2026-03-01T10:00:00+02:00', end: '2026-03-01T11:00:00+02:00' },
      },
      ctx: baseCtx(),
    });

    expect(result).toMatchObject({ ok: false, retryable: false, errorCode: 'GOOGLE_AUTH_REVOKED' });
  });

  it('reports a retryable GOOGLE_TOKEN_REFRESH_FAILED on a 5xx from the token endpoint', async () => {
    server.use(
      http.post('https://oauth2.googleapis.com/token', () =>
        HttpResponse.json({ error: 'server_error' }, { status: 503 }),
      ),
    );

    const result = await calendarBridgeModule.execute({
      config,
      payload: {
        customer: { name: 'Ana' },
        booking: { start: '2026-03-01T10:00:00+02:00', end: '2026-03-01T11:00:00+02:00' },
      },
      ctx: baseCtx(),
    });

    expect(result).toMatchObject({
      ok: false,
      retryable: true,
      errorCode: 'GOOGLE_TOKEN_REFRESH_FAILED',
    });
  });

  it('propagates a retryable Calendar API failure', async () => {
    server.use(
      http.post('https://oauth2.googleapis.com/token', () =>
        HttpResponse.json({ access_token: 'tok_123' }),
      ),
      http.post('https://www.googleapis.com/calendar/v3/calendars/primary/events', () =>
        HttpResponse.json({ error: { code: 503, message: 'backendError' } }, { status: 503 }),
      ),
    );

    const result = await calendarBridgeModule.execute({
      config,
      payload: {
        customer: { name: 'Ana' },
        booking: { start: '2026-03-01T10:00:00+02:00', end: '2026-03-01T11:00:00+02:00' },
      },
      ctx: baseCtx(),
    });

    expect(result).toMatchObject({ ok: false, retryable: true, errorCode: 'GOOGLE_CALENDAR_503' });
  });
});

describe('calendarBridgeModule.scheduleFollowUp (Advanced: SMS reminder)', () => {
  const successResult = {
    ok: true as const,
    statusCode: 200,
    request: {},
    response: {},
    extra: { googleEventId: 'evt_abc', startIso: '2026-03-01T10:00:00.000+02:00' },
  };
  const reminderConfig = {
    ...config,
    reminderMode: 'twilio' as const,
    reminderOffsetMinutes: 120,
    reminderRecipientPath: '$.customer.phone',
    reminderTemplate: 'Reminder soon',
    reminderAccountSid: 'AC1',
    reminderFrom: '+15551234567',
    reminderSecret: 'tok1',
  };

  it('returns undefined when the reminder is off', () => {
    expect(
      calendarBridgeModule.scheduleFollowUp?.({ config, result: successResult }),
    ).toBeUndefined();
  });

  it('computes runAt as the event start time minus the configured offset', () => {
    // A start time well in the future, independent of "now" at test-run time, so this doesn't
    // depend on the fixed 2026-03-01 sample (which scheduleFollowUp correctly treats as past once
    // real time moves beyond it).
    const startIso = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();
    const followUp = calendarBridgeModule.scheduleFollowUp?.({
      config: reminderConfig,
      result: { ...successResult, extra: { ...successResult.extra, startIso } },
    });
    expect(followUp?.runAt.getTime()).toBe(new Date(startIso).getTime() - 120 * 60_000);
  });

  it('returns undefined when the computed runAt has already passed', () => {
    // The event starts in 1 hour, but the offset asks for a reminder a week early — already past.
    const startIso = new Date(Date.now() + 3600_000).toISOString();
    const followUp = calendarBridgeModule.scheduleFollowUp?.({
      config: { ...reminderConfig, reminderOffsetMinutes: 7 * 24 * 60 },
      result: { ...successResult, extra: { ...successResult.extra, startIso } },
    });
    expect(followUp).toBeUndefined();
  });

  it('returns undefined when the result has no startIso (defensive: should not happen in practice)', () => {
    const followUp = calendarBridgeModule.scheduleFollowUp?.({
      config: reminderConfig,
      result: { ...successResult, extra: { googleEventId: 'evt_abc' } },
    });
    expect(followUp).toBeUndefined();
  });
});
