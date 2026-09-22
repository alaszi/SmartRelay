import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSafeHttpClient } from './safe-http';
import {
  chatRelayModule,
  looksLikeDiscordWebhookUrl,
  type ChatRelayConfig,
} from './module-chat-relay';

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

const telegramConfig: ChatRelayConfig = {
  platform: 'telegram',
  botToken: '123:ABC',
  chatId: '999',
  template: 'Order #{{$.order.id}} from {{$.customer.name}}',
};

const discordConfig: ChatRelayConfig = {
  platform: 'discord',
  webhookUrl: 'https://discord.com/api/webhooks/1/token',
  template: 'Order #{{$.order.id}} from {{$.customer.name}}',
};

describe('chatRelayModule contract', () => {
  it('always prices as relay_http', () => {
    expect(chatRelayModule.priceKind(telegramConfig)).toBe('relay_http');
    expect(chatRelayModule.priceKind(discordConfig)).toBe('relay_http');
  });

  it('validates each platform variant and rejects an unknown platform', () => {
    expect(chatRelayModule.configSchema.safeParse(telegramConfig).success).toBe(true);
    expect(chatRelayModule.configSchema.safeParse(discordConfig).success).toBe(true);
    expect(chatRelayModule.configSchema.safeParse({ platform: 'slack' }).success).toBe(false);
  });

  it('rejects a telegram button with both url and callbackData, or neither', () => {
    const both = {
      ...telegramConfig,
      buttons: [[{ label: 'x', url: 'https://a', callbackData: 'y' }]],
    };
    const neither = { ...telegramConfig, buttons: [[{ label: 'x' }]] };
    expect(chatRelayModule.configSchema.safeParse(both).success).toBe(false);
    expect(chatRelayModule.configSchema.safeParse(neither).success).toBe(false);
  });

  it('accepts a telegram button with exactly one of url/callbackData', () => {
    const urlOnly = { ...telegramConfig, buttons: [[{ label: 'Visit', url: 'https://a' }]] };
    const callbackOnly = { ...telegramConfig, buttons: [[{ label: 'Yes', callbackData: 'yes' }]] };
    expect(chatRelayModule.configSchema.safeParse(urlOnly).success).toBe(true);
    expect(chatRelayModule.configSchema.safeParse(callbackOnly).success).toBe(true);
  });
});

describe('looksLikeDiscordWebhookUrl', () => {
  it.each([
    'https://discord.com/api/webhooks/123456789/abcDEF-token_value',
    'https://discordapp.com/api/webhooks/123456789/token',
    'https://discord.com/api/v10/webhooks/123456789/token',
  ])('accepts %s', (url) => {
    expect(looksLikeDiscordWebhookUrl(url)).toBe(true);
  });

  it.each([
    'https://discord.com/api/webhooks/',
    'https://discord.com/api/webhooks/notanumber/token',
    'https://evil.example/api/webhooks/123/token',
    'https://discord.com/not-webhooks/123/token',
    'not a url',
    '',
  ])('rejects %j', (url) => {
    expect(looksLikeDiscordWebhookUrl(url)).toBe(false);
  });
});

describe('chatRelayModule.execute: Telegram', () => {
  it('renders the template with MarkdownV2-escaped values and sends it', async () => {
    let seenBody: { text?: string } | undefined;
    server.use(
      http.post('https://api.telegram.org/bot123:ABC/sendMessage', async ({ request }) => {
        seenBody = (await request.json()) as typeof seenBody;
        return HttpResponse.json({ ok: true, result: { message_id: 1 } });
      }),
    );

    const result = await chatRelayModule.execute({
      config: telegramConfig,
      payload: { order: { id: 1042 }, customer: { name: 'Ana.Maria' } },
      ctx,
    });

    expect(result).toMatchObject({ ok: true });
    // The literal template text (#, spaces) is untouched; only the substituted "." in the name is
    // escaped, proving payload data cannot break MarkdownV2 formatting.
    expect(seenBody?.text).toBe('Order #1042 from Ana\\.Maria');
  });

  it('does not escape the literal template characters, only substituted values', async () => {
    let seenBody: { text?: string } | undefined;
    server.use(
      http.post('https://api.telegram.org/bot123:ABC/sendMessage', async ({ request }) => {
        seenBody = (await request.json()) as typeof seenBody;
        return HttpResponse.json({ ok: true, result: {} });
      }),
    );

    await chatRelayModule.execute({
      config: { ...telegramConfig, template: '*Order* #{{$.order.id}}!' },
      payload: { order: { id: 7 } },
      ctx,
    });

    expect(seenBody?.text).toBe('*Order* #7!'); // literal * and # and ! stay unescaped
  });

  it('sends inline buttons, rendering a templated url but leaving callback_data as-is', async () => {
    let seenBody: { reply_markup?: { inline_keyboard: unknown[][] } } | undefined;
    server.use(
      http.post('https://api.telegram.org/bot123:ABC/sendMessage', async ({ request }) => {
        seenBody = (await request.json()) as typeof seenBody;
        return HttpResponse.json({ ok: true, result: {} });
      }),
    );

    await chatRelayModule.execute({
      config: {
        ...telegramConfig,
        buttons: [
          [
            { label: 'Track', url: 'https://example.com/order/{{$.order.id}}' },
            { label: 'Confirm', callbackData: 'confirm:{{$.order.id}}' },
          ],
        ],
      },
      payload: { order: { id: 1042 }, customer: { name: 'Ana' } },
      ctx,
    });

    expect(seenBody?.reply_markup?.inline_keyboard).toEqual([
      [
        { text: 'Track', url: 'https://example.com/order/1042' },
        // callback_data is not a template per the plan; sent verbatim.
        { text: 'Confirm', callback_data: 'confirm:{{$.order.id}}' },
      ],
    ]);
  });

  it('truncates to 4096 chars with an ellipsis and never leaves a dangling escape backslash', async () => {
    let seenBody: { text?: string } | undefined;
    server.use(
      http.post('https://api.telegram.org/bot123:ABC/sendMessage', async ({ request }) => {
        seenBody = (await request.json()) as typeof seenBody;
        return HttpResponse.json({ ok: true, result: {} });
      }),
    );

    // Every other character is a literal '.', so escaped output is "a\.a\.a\.a\...": whichever
    // position the 4096-char cut lands on, this exercises the odd-trailing-backslash trim.
    const longValue = 'a.'.repeat(3000);
    await chatRelayModule.execute({
      config: { ...telegramConfig, template: '{{$.order.id}}' },
      payload: { order: { id: longValue } },
      ctx,
    });

    const text = seenBody?.text ?? '';
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text.endsWith('…')).toBe(true);
    const beforeEllipsis = text.slice(0, -1);
    const trailingBackslashes = beforeEllipsis.length - beforeEllipsis.replace(/\\+$/, '').length;
    expect(trailingBackslashes % 2).toBe(0);
  });

  it('reports TEMPLATE_VAR_MISSING for the message template without calling Telegram', async () => {
    server.use(http.all('*', () => new Response('should not be called', { status: 500 })));

    const result = await chatRelayModule.execute({
      config: { ...telegramConfig, template: '{{$.missing}}' },
      payload: { order: { id: 1 } },
      ctx,
    });

    expect(result).toMatchObject({
      ok: false,
      retryable: false,
      errorCode: 'TEMPLATE_VAR_MISSING',
    });
  });

  it('reports TEMPLATE_VAR_MISSING for a button url template without calling Telegram', async () => {
    server.use(http.all('*', () => new Response('should not be called', { status: 500 })));

    const result = await chatRelayModule.execute({
      config: {
        ...telegramConfig,
        buttons: [[{ label: 'x', url: 'https://example.com/{{$.missing}}' }]],
      },
      payload: { order: { id: 1 } },
      ctx,
    });

    expect(result).toMatchObject({
      ok: false,
      retryable: false,
      errorCode: 'TEMPLATE_VAR_MISSING',
    });
  });

  it('propagates a retryable Telegram error with retryAfterMs', async () => {
    server.use(
      http.post('https://api.telegram.org/bot123:ABC/sendMessage', () =>
        HttpResponse.json(
          { ok: false, error_code: 429, description: 'flood' },
          {
            status: 429,
            headers: { 'retry-after': '5' },
          },
        ),
      ),
    );

    const result = await chatRelayModule.execute({
      config: telegramConfig,
      payload: { order: { id: 1 }, customer: { name: 'Ana' } },
      ctx,
    });

    expect(result).toMatchObject({ ok: false, retryable: true, retryAfterMs: 5_000 });
  });
});

describe('chatRelayModule.execute: Discord', () => {
  it('renders the template (no MarkdownV2 escaping) and sends it', async () => {
    let seenBody: { content?: string } | undefined;
    server.use(
      http.post('https://discord.com/api/webhooks/1/token', async ({ request }) => {
        seenBody = (await request.json()) as typeof seenBody;
        return new Response(null, { status: 204 });
      }),
    );

    const result = await chatRelayModule.execute({
      config: discordConfig,
      payload: { order: { id: 1042 }, customer: { name: 'Ana.Maria' } },
      ctx,
    });

    expect(result).toMatchObject({ ok: true, statusCode: 204 });
    expect(seenBody?.content).toBe('Order #1042 from Ana.Maria'); // unescaped: Discord has no parse_mode
  });

  it('truncates to 2000 chars with an ellipsis', async () => {
    let seenBody: { content?: string } | undefined;
    server.use(
      http.post('https://discord.com/api/webhooks/1/token', async ({ request }) => {
        seenBody = (await request.json()) as typeof seenBody;
        return new Response(null, { status: 204 });
      }),
    );

    await chatRelayModule.execute({
      config: { ...discordConfig, template: '{{$.order.id}}' },
      payload: { order: { id: 'x'.repeat(3000) } },
      ctx,
    });

    expect(seenBody?.content?.length).toBe(2000);
    expect(seenBody?.content?.endsWith('…')).toBe(true);
  });

  it('treats a 5xx as retryable and a 4xx as terminal', async () => {
    server.use(
      http.post('https://discord.com/api/webhooks/1/token', () =>
        HttpResponse.json({}, { status: 503 }),
      ),
    );
    const retryable = await chatRelayModule.execute({
      config: discordConfig,
      payload: { order: { id: 1 }, customer: { name: 'Ana' } },
      ctx,
    });
    expect(retryable).toMatchObject({ ok: false, retryable: true });

    server.use(
      http.post('https://discord.com/api/webhooks/1/token', () =>
        HttpResponse.json({}, { status: 400 }),
      ),
    );
    const terminal = await chatRelayModule.execute({
      config: discordConfig,
      payload: { order: { id: 1 }, customer: { name: 'Ana' } },
      ctx,
    });
    expect(terminal).toMatchObject({ ok: false, retryable: false });
  });
});
