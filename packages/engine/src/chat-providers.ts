import { parseRetryAfterMs } from './retry-after';
import type { SafeHttpClient } from './safe-http';

// The 18 characters MarkdownV2 requires escaping outside formatting entities, plus backslash
// itself. Verified against core.telegram.org/bots/api#markdownv2-style.
const MARKDOWNV2_SPECIAL_CHARS = /[_*[\]()~`>#+\-=|{}.!\\]/g;

/** Escapes one substituted template value for Telegram's MarkdownV2 (never the literal template
 * text): payload data can never break the message's formatting. */
export function escapeMarkdownV2(value: string): string {
  return value.replace(MARKDOWNV2_SPECIAL_CHARS, '\\$&');
}

export type ChatSendResult =
  | { ok: true; statusCode: number; request: unknown; response: unknown }
  | {
      ok: false;
      retryable: boolean;
      errorCode: string;
      message: string;
      statusCode?: number;
      retryAfterMs?: number;
      request?: unknown;
      response?: unknown;
    };

// ---------------------------------------------------------------------------------------------
// Telegram Bot API: verified against core.telegram.org/bots/api (sendMessage, getMe,
// answerCallbackQuery, setWebhook).
// ---------------------------------------------------------------------------------------------

export interface TelegramInlineButton {
  label: string;
  /** Exactly one of url/callbackData is set (enforced by the module's config schema). */
  url?: string;
  callbackData?: string;
}

interface TelegramApiResponse {
  ok: boolean;
  result?: unknown;
  error_code?: number;
  description?: string;
}

function telegramUrl(botToken: string, method: string): string {
  return `https://api.telegram.org/bot${encodeURIComponent(botToken)}/${method}`;
}

async function callTelegram(
  http: SafeHttpClient,
  botToken: string,
  method: string,
  body: Record<string, unknown>,
): Promise<{
  status: number;
  parsed: TelegramApiResponse | undefined;
  raw: string;
  headers: Record<string, string>;
}> {
  const response = await http.request({
    url: telegramUrl(botToken, method),
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let parsed: TelegramApiResponse | undefined;
  try {
    parsed = JSON.parse(response.body) as TelegramApiResponse;
  } catch {
    parsed = undefined;
  }
  return { status: response.status, parsed, raw: response.body, headers: response.headers };
}

export interface TelegramSendInput {
  botToken: string;
  chatId: string;
  text: string;
  parseMode: 'MarkdownV2';
  buttons?: TelegramInlineButton[][];
  http: SafeHttpClient;
}

export async function sendTelegramMessage(input: TelegramSendInput): Promise<ChatSendResult> {
  const body: Record<string, unknown> = {
    chat_id: input.chatId,
    text: input.text,
    parse_mode: input.parseMode,
  };
  if (input.buttons && input.buttons.length > 0) {
    body['reply_markup'] = {
      inline_keyboard: input.buttons.map((row) =>
        row.map((button) => ({
          text: button.label,
          ...(button.url !== undefined ? { url: button.url } : {}),
          ...(button.callbackData !== undefined ? { callback_data: button.callbackData } : {}),
        })),
      ),
    };
  }

  const { status, parsed, raw, headers } = await callTelegram(
    input.http,
    input.botToken,
    'sendMessage',
    body,
  );

  if (status >= 200 && status < 300 && parsed?.ok) {
    return { ok: true, statusCode: status, request: body, response: parsed.result };
  }

  const retryable = status >= 500 || status === 429;
  const retryAfterMs = retryable ? parseRetryAfterMs(headers['retry-after']) : undefined;
  return {
    ok: false,
    retryable,
    errorCode: `TELEGRAM_${parsed?.error_code ?? status}`,
    message: parsed?.description ?? `Telegram answered HTTP ${status}`,
    statusCode: status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    request: body,
    response: raw,
  };
}

export type TelegramTokenCheck = { ok: true; username: string } | { ok: false; message: string };

/** MASTER_PLAN section 6: "on save, verify token via getMe". */
export async function verifyTelegramToken(
  botToken: string,
  http: SafeHttpClient,
): Promise<TelegramTokenCheck> {
  const { status, parsed } = await callTelegram(http, botToken, 'getMe', {});
  if (status >= 200 && status < 300 && parsed?.ok) {
    const username = (parsed.result as { username?: string } | undefined)?.username ?? '';
    return { ok: true, username };
  }
  return {
    ok: false,
    message: parsed?.description ?? `Telegram rejected the bot token (HTTP ${status})`,
  };
}

/** Registers the button-callback route so Telegram delivers callback_query updates to it. */
export async function registerTelegramWebhook(
  botToken: string,
  callbackUrl: string,
  secretToken: string,
  http: SafeHttpClient,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { status, parsed } = await callTelegram(http, botToken, 'setWebhook', {
    url: callbackUrl,
    secret_token: secretToken,
  });
  if (status >= 200 && status < 300 && parsed?.ok) return { ok: true };
  return { ok: false, message: parsed?.description ?? `setWebhook failed (HTTP ${status})` };
}

/** Acknowledges an inline button press (decision D5: logged as an inbound event, no forwarding). */
export async function answerTelegramCallback(
  botToken: string,
  callbackQueryId: string,
  http: SafeHttpClient,
): Promise<{ ok: boolean }> {
  const { status, parsed } = await callTelegram(http, botToken, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
  });
  return { ok: status >= 200 && status < 300 && (parsed?.ok ?? false) };
}

// ---------------------------------------------------------------------------------------------
// Discord webhooks: verified against docs.discord.com/developers/resources/webhook (Execute
// Webhook: POST <webhook URL>, JSON body { content }; default response 204 No Content).
// ---------------------------------------------------------------------------------------------

export async function sendDiscordMessage(
  webhookUrl: string,
  text: string,
  http: SafeHttpClient,
): Promise<ChatSendResult> {
  const body = JSON.stringify({ content: text });
  const response = await http.request({
    url: webhookUrl,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });

  if (response.status >= 200 && response.status < 300) {
    let parsed: unknown;
    try {
      parsed = response.body.length > 0 ? JSON.parse(response.body) : undefined;
    } catch {
      parsed = response.body;
    }
    return { ok: true, statusCode: response.status, request: { content: text }, response: parsed };
  }

  const retryable = response.status >= 500 || response.status === 429;
  const retryAfterMs = retryable ? parseRetryAfterMs(response.headers['retry-after']) : undefined;
  return {
    ok: false,
    retryable,
    errorCode: 'DISCORD_HTTP_ERROR',
    message: `Discord answered HTTP ${response.status}`,
    statusCode: response.status,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    request: { content: text },
    response: response.body,
  };
}
