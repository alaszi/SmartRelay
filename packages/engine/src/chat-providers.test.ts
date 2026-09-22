import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSafeHttpClient } from './safe-http';
import {
  answerTelegramCallback,
  escapeMarkdownV2,
  registerTelegramWebhook,
  sendDiscordMessage,
  sendTelegramMessage,
  verifyTelegramToken,
} from './chat-providers';

describe('escapeMarkdownV2', () => {
  it('escapes every documented special character', () => {
    expect(escapeMarkdownV2('_*[]()~`>#+-=|{}.!')).toBe(
      '\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!',
    );
  });

  it('escapes a literal backslash', () => {
    expect(escapeMarkdownV2('C:\\path')).toBe('C:\\\\path');
  });

  it('leaves ordinary text, digits and unicode untouched', () => {
    expect(escapeMarkdownV2('Ana Kovács 42 ș ț 👋')).toBe('Ana Kovács 42 ș ț 👋');
  });

  it('escapes each occurrence when a character repeats', () => {
    expect(escapeMarkdownV2('a.b.c')).toBe('a\\.b\\.c');
  });
});

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const http_ = createSafeHttpClient({
  resolver: async () => [{ address: '93.184.216.34', family: 4 }],
});

describe('sendTelegramMessage', () => {
  it('sends chat_id/text/parse_mode and returns the result on success', async () => {
    let seenBody: unknown;
    server.use(
      http.post('https://api.telegram.org/bot123:ABC/sendMessage', async ({ request }) => {
        seenBody = await request.json();
        return HttpResponse.json({ ok: true, result: { message_id: 42 } });
      }),
    );

    const result = await sendTelegramMessage({
      botToken: '123:ABC',
      chatId: '999',
      text: 'Hi Ana',
      parseMode: 'MarkdownV2',
      http: http_,
    });

    expect(result).toMatchObject({ ok: true, statusCode: 200 });
    expect(seenBody).toMatchObject({ chat_id: '999', text: 'Hi Ana', parse_mode: 'MarkdownV2' });
  });

  it('includes an inline_keyboard reply_markup with url and callback_data buttons', async () => {
    let seenBody: { reply_markup?: { inline_keyboard: unknown[][] } } | undefined;
    server.use(
      http.post('https://api.telegram.org/bot123:ABC/sendMessage', async ({ request }) => {
        seenBody = (await request.json()) as typeof seenBody;
        return HttpResponse.json({ ok: true, result: {} });
      }),
    );

    await sendTelegramMessage({
      botToken: '123:ABC',
      chatId: '999',
      text: 'Choose',
      parseMode: 'MarkdownV2',
      buttons: [
        [
          { label: 'Visit', url: 'https://example.com' },
          { label: 'Confirm', callbackData: 'yes' },
        ],
      ],
      http: http_,
    });

    expect(seenBody?.reply_markup?.inline_keyboard).toEqual([
      [
        { text: 'Visit', url: 'https://example.com' },
        { text: 'Confirm', callback_data: 'yes' },
      ],
    ]);
  });

  it('omits reply_markup when there are no buttons', async () => {
    let seenBody: Record<string, unknown> | undefined;
    server.use(
      http.post('https://api.telegram.org/bot123:ABC/sendMessage', async ({ request }) => {
        seenBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true, result: {} });
      }),
    );
    await sendTelegramMessage({
      botToken: '123:ABC',
      chatId: '1',
      text: 'x',
      parseMode: 'MarkdownV2',
      http: http_,
    });
    expect(seenBody).not.toHaveProperty('reply_markup');
  });

  it('parses a Telegram {ok:false} error body into errorCode/message', async () => {
    server.use(
      http.post('https://api.telegram.org/bot123:ABC/sendMessage', () =>
        HttpResponse.json(
          { ok: false, error_code: 400, description: 'chat not found' },
          { status: 400 },
        ),
      ),
    );

    const result = await sendTelegramMessage({
      botToken: '123:ABC',
      chatId: '1',
      text: 'x',
      parseMode: 'MarkdownV2',
      http: http_,
    });

    expect(result).toMatchObject({
      ok: false,
      retryable: false,
      errorCode: 'TELEGRAM_400',
      message: 'chat not found',
    });
  });

  it('treats HTTP 5xx and 429 as retryable, and reads Retry-After', async () => {
    server.use(
      http.post('https://api.telegram.org/bot123:ABC/sendMessage', () =>
        HttpResponse.json(
          { ok: false, error_code: 429, description: 'too many requests' },
          {
            status: 429,
            headers: { 'retry-after': '30' },
          },
        ),
      ),
    );

    const result = await sendTelegramMessage({
      botToken: '123:ABC',
      chatId: '1',
      text: 'x',
      parseMode: 'MarkdownV2',
      http: http_,
    });

    expect(result).toMatchObject({ ok: false, retryable: true, retryAfterMs: 30_000 });
  });

  it('does not leak the bot token in the result', async () => {
    server.use(
      http.post('https://api.telegram.org/botsecret-token-here/sendMessage', () =>
        HttpResponse.json(
          { ok: false, error_code: 401, description: 'unauthorized' },
          { status: 401 },
        ),
      ),
    );
    const result = await sendTelegramMessage({
      botToken: 'secret-token-here',
      chatId: '1',
      text: 'x',
      parseMode: 'MarkdownV2',
      http: http_,
    });
    expect(JSON.stringify(result)).not.toContain('secret-token-here');
  });
});

describe('verifyTelegramToken', () => {
  it('returns ok with the bot username on success', async () => {
    server.use(
      http.post('https://api.telegram.org/bot123:ABC/getMe', () =>
        HttpResponse.json({ ok: true, result: { id: 1, is_bot: true, username: 'my_bot' } }),
      ),
    );
    expect(await verifyTelegramToken('123:ABC', http_)).toEqual({ ok: true, username: 'my_bot' });
  });

  it('returns a message on an invalid token', async () => {
    server.use(
      http.post('https://api.telegram.org/botbad/getMe', () =>
        HttpResponse.json(
          { ok: false, error_code: 401, description: 'Unauthorized' },
          { status: 401 },
        ),
      ),
    );
    expect(await verifyTelegramToken('bad', http_)).toEqual({ ok: false, message: 'Unauthorized' });
  });
});

describe('registerTelegramWebhook / answerTelegramCallback', () => {
  it('registers the webhook URL and secret token', async () => {
    let seenBody: Record<string, unknown> | undefined;
    server.use(
      http.post('https://api.telegram.org/bot123:ABC/setWebhook', async ({ request }) => {
        seenBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true, result: true });
      }),
    );
    const result = await registerTelegramWebhook(
      '123:ABC',
      'https://app.example.com/tg/relay1/secret1',
      'secret1',
      http_,
    );
    expect(result).toEqual({ ok: true });
    expect(seenBody).toEqual({
      url: 'https://app.example.com/tg/relay1/secret1',
      secret_token: 'secret1',
    });
  });

  it('acknowledges a callback query', async () => {
    server.use(
      http.post('https://api.telegram.org/bot123:ABC/answerCallbackQuery', () =>
        HttpResponse.json({ ok: true, result: true }),
      ),
    );
    expect(await answerTelegramCallback('123:ABC', 'cbq1', http_)).toEqual({ ok: true });
  });
});

describe('sendDiscordMessage', () => {
  it('POSTs { content } and succeeds on 204 No Content', async () => {
    let seenBody: unknown;
    server.use(
      http.post('https://discord.com/api/webhooks/1/token', async ({ request }) => {
        seenBody = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const result = await sendDiscordMessage(
      'https://discord.com/api/webhooks/1/token',
      'Hi Ana',
      http_,
    );

    expect(result).toMatchObject({ ok: true, statusCode: 204 });
    expect(seenBody).toEqual({ content: 'Hi Ana' });
  });

  it('treats HTTP 429 as retryable and reads Retry-After', async () => {
    server.use(
      http.post('https://discord.com/api/webhooks/1/token', () =>
        HttpResponse.json(
          { message: 'rate limited', retry_after: 2.5 },
          {
            status: 429,
            headers: { 'retry-after': '3' },
          },
        ),
      ),
    );

    const result = await sendDiscordMessage(
      'https://discord.com/api/webhooks/1/token',
      'Hi',
      http_,
    );

    expect(result).toMatchObject({ ok: false, retryable: true, retryAfterMs: 3_000 });
  });

  it('treats HTTP 400 as terminal', async () => {
    server.use(
      http.post('https://discord.com/api/webhooks/1/token', () =>
        HttpResponse.json({ message: 'bad request' }, { status: 400 }),
      ),
    );
    const result = await sendDiscordMessage(
      'https://discord.com/api/webhooks/1/token',
      'Hi',
      http_,
    );
    expect(result).toMatchObject({ ok: false, retryable: false });
  });
});
