import { LIMITS } from '@smartrelay/shared';
import { z } from 'zod';
import {
  escapeMarkdownV2,
  sendDiscordMessage,
  sendTelegramMessage,
  type ChatSendResult,
  type TelegramInlineButton,
} from './chat-providers';
import type { ModuleResult, RelayModule } from './module';
import { renderTemplate, TemplateError } from './template';

const TELEGRAM_TEXT_LIMIT = 4096;
const DISCORD_TEXT_LIMIT = 2000;
const ELLIPSIS = '…';

/**
 * Truncates to at most `maxLength` characters, appending an ellipsis. `avoidDanglingEscape` trims
 * one more character when the cut would leave an odd (unterminated) run of trailing backslashes —
 * MarkdownV2 requires every backslash to start a valid escape pair, and Telegram rejects the whole
 * message otherwise.
 */
function truncateWithEllipsis(
  text: string,
  maxLength: number,
  avoidDanglingEscape: boolean,
): string {
  if (text.length <= maxLength) return text;

  let truncated = text.slice(0, maxLength - ELLIPSIS.length);
  if (avoidDanglingEscape) {
    let trailingBackslashes = 0;
    for (let i = truncated.length - 1; i >= 0 && truncated[i] === '\\'; i--) trailingBackslashes++;
    if (trailingBackslashes % 2 === 1) truncated = truncated.slice(0, -1);
  }
  return truncated + ELLIPSIS;
}

function toModuleResult(send: ChatSendResult): ModuleResult {
  if (send.ok) {
    return {
      ok: true,
      statusCode: send.statusCode,
      request: send.request,
      response: send.response,
    };
  }
  return {
    ok: false,
    retryable: send.retryable,
    errorCode: send.errorCode,
    message: send.message,
    ...(send.statusCode === undefined ? {} : { statusCode: send.statusCode }),
    ...(send.retryAfterMs === undefined ? {} : { retryAfterMs: send.retryAfterMs }),
    ...(send.request === undefined ? {} : { request: send.request }),
    ...(send.response === undefined ? {} : { response: send.response }),
  };
}

const templateField = z.string().min(1).max(LIMITS.maxTemplateLength);

const telegramButtonSchema = z
  .object({
    label: z.string().min(1).max(64),
    url: templateField.optional(),
    callbackData: z.string().min(1).max(64).optional(),
  })
  .refine((button) => (button.url !== undefined) !== (button.callbackData !== undefined), {
    message: 'exactly one of url or callbackData must be set',
  });

const telegramConfigSchema = z.object({
  platform: z.literal('telegram'),
  botToken: z.string().min(1),
  chatId: z.string().min(1),
  template: templateField,
  /** Advanced. Rows of buttons; a button's `url` may itself be a template. */
  buttons: z.array(z.array(telegramButtonSchema).min(1)).max(10).optional(),
});

const discordConfigSchema = z.object({
  platform: z.literal('discord'),
  webhookUrl: z.url(),
  template: templateField,
});

export const chatRelayConfigSchema = z.discriminatedUnion('platform', [
  telegramConfigSchema,
  discordConfigSchema,
]);

export type ChatRelayConfig = z.infer<typeof chatRelayConfigSchema>;

/** MASTER_PLAN section 6: "URL shape check (Discord)" — used at relay save time. */
export function looksLikeDiscordWebhookUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.hostname === 'discord.com' || parsed.hostname === 'discordapp.com') &&
      /^\/api(\/v\d+)?\/webhooks\/\d+\/.+/.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function renderTelegramButtons(
  buttons: NonNullable<z.infer<typeof telegramConfigSchema>['buttons']>,
  payload: unknown,
): TelegramInlineButton[][] {
  return buttons.map((row) =>
    row.map((button) => ({
      label: button.label,
      // A button URL is a plain URL, not MarkdownV2 text, so its rendered value is not escaped.
      ...(button.url !== undefined ? { url: renderTemplate(button.url, payload) } : {}),
      ...(button.callbackData !== undefined ? { callbackData: button.callbackData } : {}),
    })),
  );
}

/** Module 3: Telegram / Discord (MASTER_PLAN section 6). Always priced as `relay_http`. */
export const chatRelayModule: RelayModule<ChatRelayConfig> = {
  type: 'chat_relay',
  configSchema: chatRelayConfigSchema,
  priceKind: () => 'relay_http',
  sampleInput: () => ({ customer: { name: 'Ana' }, order: { id: 1042 } }),

  async execute({ config, payload, ctx }) {
    try {
      if (config.platform === 'telegram') {
        const text = truncateWithEllipsis(
          renderTemplate(config.template, payload, { escapeValue: escapeMarkdownV2 }),
          TELEGRAM_TEXT_LIMIT,
          true,
        );
        const buttons = config.buttons ? renderTelegramButtons(config.buttons, payload) : undefined;
        const send = await sendTelegramMessage({
          botToken: config.botToken,
          chatId: config.chatId,
          text,
          parseMode: 'MarkdownV2',
          ...(buttons ? { buttons } : {}),
          http: ctx.http,
        });
        return toModuleResult(send);
      }

      const text = truncateWithEllipsis(
        renderTemplate(config.template, payload),
        DISCORD_TEXT_LIMIT,
        false,
      );
      const send = await sendDiscordMessage(config.webhookUrl, text, ctx.http);
      return toModuleResult(send);
    } catch (error) {
      if (error instanceof TemplateError) {
        return { ok: false, retryable: false, errorCode: error.code, message: error.message };
      }
      throw error;
    }
  },
};
