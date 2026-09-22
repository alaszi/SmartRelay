import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSafeHttpClient } from './safe-http';
import {
  buildDefaultEmailPayload,
  emailApiModule,
  isLoopedEmail,
  matchesEmailFilter,
  type NormalizedInboundEmail,
} from './module-email-api';

const baseEmail: NormalizedInboundEmail = {
  from: 'customer@example.com',
  to: 'r_abc12345@inbound.smartrelay.ro',
  subject: 'New order #1042',
  receivedAt: '2026-01-01T10:00:00.000Z',
  messageId: '<abc@mail.example.com>',
  text: 'Name: Ana\nOrder: 1042\nTotal: 49.90',
  headers: {},
};

describe('buildDefaultEmailPayload', () => {
  it('parses "Key: Value" lines into fields', () => {
    const payload = buildDefaultEmailPayload(baseEmail);
    expect(payload.fields).toEqual({ Name: 'Ana', Order: '1042', Total: '49.90' });
    expect(payload.meta).toEqual({
      from: 'customer@example.com',
      to: 'r_abc12345@inbound.smartrelay.ro',
      subject: 'New order #1042',
      receivedAt: '2026-01-01T10:00:00.000Z',
      messageId: '<abc@mail.example.com>',
    });
    expect(payload.raw).toEqual({ text: baseEmail.text });
  });

  it('ignores lines without a colon and trims whitespace around key/value', () => {
    const payload = buildDefaultEmailPayload({
      ...baseEmail,
      text: 'Hello there\nName:   Ana  \nno-colon-line\nOrder:1042',
    });
    expect(payload.fields).toEqual({ Name: 'Ana', Order: '1042' });
  });

  it('keeps the html body when present, omits it when absent', () => {
    expect(buildDefaultEmailPayload(baseEmail).raw.html).toBeUndefined();
    expect(buildDefaultEmailPayload({ ...baseEmail, html: '<p>hi</p>' }).raw.html).toBe(
      '<p>hi</p>',
    );
  });

  it('handles CRLF line endings and an empty body', () => {
    expect(
      buildDefaultEmailPayload({ ...baseEmail, text: 'Name: Ana\r\nOrder: 1042\r\n' }).fields,
    ).toEqual({
      Name: 'Ana',
      Order: '1042',
    });
    expect(buildDefaultEmailPayload({ ...baseEmail, text: '' }).fields).toEqual({});
  });

  it('uses the last value when a key repeats', () => {
    expect(
      buildDefaultEmailPayload({ ...baseEmail, text: 'Order: 1\nOrder: 2' }).fields.Order,
    ).toBe('2');
  });
});

describe('matchesEmailFilter', () => {
  it('matches everything when no filter is configured', () => {
    expect(matchesEmailFilter(baseEmail, undefined)).toBe(true);
  });

  it('checks subjectContains', () => {
    expect(matchesEmailFilter(baseEmail, { subjectContains: 'order' })).toBe(true);
    expect(matchesEmailFilter(baseEmail, { subjectContains: 'invoice' })).toBe(false);
  });

  it('checks senderEquals, case-insensitively', () => {
    expect(matchesEmailFilter(baseEmail, { senderEquals: 'CUSTOMER@example.com' })).toBe(true);
    expect(matchesEmailFilter(baseEmail, { senderEquals: 'other@example.com' })).toBe(false);
  });

  it('requires every configured condition to match', () => {
    expect(
      matchesEmailFilter(baseEmail, { subjectContains: 'order', senderEquals: 'nope@example.com' }),
    ).toBe(false);
  });
});

describe('isLoopedEmail', () => {
  const platformDomain = 'smartrelay.ro';

  it('is false for an ordinary email', () => {
    expect(isLoopedEmail(baseEmail, platformDomain)).toBe(false);
  });

  it.each(['yes', 'auto-generated', 'AUTO-REPLIED'])('drops Auto-Submitted: %s', (value) => {
    expect(
      isLoopedEmail({ ...baseEmail, headers: { 'auto-submitted': value } }, platformDomain),
    ).toBe(true);
  });

  it('does not drop an explicit Auto-Submitted: no', () => {
    expect(
      isLoopedEmail({ ...baseEmail, headers: { 'auto-submitted': 'no' } }, platformDomain),
    ).toBe(false);
  });

  it.each(['bulk', 'auto_reply', 'BULK'])('drops Precedence: %s', (value) => {
    expect(isLoopedEmail({ ...baseEmail, headers: { precedence: value } }, platformDomain)).toBe(
      true,
    );
  });

  it('does not drop Precedence: list', () => {
    expect(isLoopedEmail({ ...baseEmail, headers: { precedence: 'list' } }, platformDomain)).toBe(
      false,
    );
  });

  it("drops mail sent from the platform's own domain, case-insensitively", () => {
    expect(isLoopedEmail({ ...baseEmail, from: 'bounce@SmartRelay.ro' }, platformDomain)).toBe(
      true,
    );
    expect(isLoopedEmail({ ...baseEmail, from: 'bounce@notsmartrelay.ro' }, platformDomain)).toBe(
      false,
    );
  });
});

const mswServer = setupServer();
beforeAll(() => mswServer.listen({ onUnhandledRequest: 'error' }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

const http_ = createSafeHttpClient({
  resolver: async () => [{ address: '93.184.216.34', family: 4 }],
});
const ctx = {
  eventId: 'evt_1',
  userTimezone: 'Europe/Bucharest',
  http: http_,
  now: new Date('2026-01-01T00:00:00Z'),
};

describe('emailApiModule.execute', () => {
  it('always prices as relay_http', () => {
    expect(emailApiModule.priceKind({ targetUrl: 'https://x.example', parsingRules: [] })).toBe(
      'relay_http',
    );
  });

  it('POSTs the default output unchanged when there are no parsing rules', async () => {
    let seenBody: string | undefined;
    mswServer.use(
      http.post('https://target.example/hook', async ({ request }) => {
        seenBody = await request.text();
        return HttpResponse.json({ ok: true }, { status: 200 });
      }),
    );

    const payload = buildDefaultEmailPayload(baseEmail);
    const result = await emailApiModule.execute({
      config: { targetUrl: 'https://target.example/hook', parsingRules: [] },
      payload,
      ctx,
    });

    expect(result).toMatchObject({ ok: true, statusCode: 200 });
    expect(JSON.parse(seenBody ?? '{}')).toEqual({
      meta: payload.meta,
      fields: payload.fields,
      raw: payload.raw,
    });
  });

  it('applies a jsonpath rule reading from the payload', async () => {
    let seenBody: string | undefined;
    mswServer.use(
      http.post('https://target.example/hook', async ({ request }) => {
        seenBody = await request.text();
        return HttpResponse.json({}, { status: 200 });
      }),
    );

    const payload = buildDefaultEmailPayload(baseEmail);
    await emailApiModule.execute({
      config: {
        targetUrl: 'https://target.example/hook',
        parsingRules: [{ name: 'subjectLine', type: 'jsonpath', expression: '$.meta.subject' }],
      },
      payload,
      ctx,
    });

    const sent = JSON.parse(seenBody ?? '{}') as { fields: Record<string, string> };
    expect(sent.fields.subjectLine).toBe('New order #1042');
    expect(sent.fields.Name).toBe('Ana'); // default fields still present
  });

  it('applies a regex rule and merges every named group it captures', async () => {
    let seenBody: string | undefined;
    mswServer.use(
      http.post('https://target.example/hook', async ({ request }) => {
        seenBody = await request.text();
        return HttpResponse.json({}, { status: 200 });
      }),
    );

    const payload = buildDefaultEmailPayload({ ...baseEmail, text: 'Order #1042 total EUR 49.90' });
    await emailApiModule.execute({
      config: {
        targetUrl: 'https://target.example/hook',
        parsingRules: [
          {
            name: 'order line',
            type: 'regex',
            expression: 'Order #(?<orderId>\\d+) total EUR (?<total>[\\d.]+)',
          },
        ],
      },
      payload,
      ctx,
    });

    const sent = JSON.parse(seenBody ?? '{}') as { fields: Record<string, string> };
    expect(sent.fields.orderId).toBe('1042');
    expect(sent.fields.total).toBe('49.90');
  });

  it('a regex rule with no match leaves the default fields untouched', async () => {
    mswServer.use(
      http.post('https://target.example/hook', () => HttpResponse.json({}, { status: 200 })),
    );

    const payload = buildDefaultEmailPayload(baseEmail);
    const result = await emailApiModule.execute({
      config: {
        targetUrl: 'https://target.example/hook',
        parsingRules: [{ name: 'nope', type: 'regex', expression: 'NOMATCH(?<x>\\d+)' }],
      },
      payload,
      ctx,
    });

    expect(result.ok).toBe(true);
  });

  it('treats a 5xx destination as retryable and a 4xx as terminal', async () => {
    mswServer.use(
      http.post('https://target.example/down', () => HttpResponse.json({}, { status: 503 })),
    );
    const retryable = await emailApiModule.execute({
      config: { targetUrl: 'https://target.example/down', parsingRules: [] },
      payload: buildDefaultEmailPayload(baseEmail),
      ctx,
    });
    expect(retryable).toMatchObject({ ok: false, retryable: true });

    mswServer.use(
      http.post('https://target.example/bad', () => HttpResponse.json({}, { status: 400 })),
    );
    const terminal = await emailApiModule.execute({
      config: { targetUrl: 'https://target.example/bad', parsingRules: [] },
      payload: buildDefaultEmailPayload(baseEmail),
      ctx,
    });
    expect(terminal).toMatchObject({ ok: false, retryable: false });
  });
});
