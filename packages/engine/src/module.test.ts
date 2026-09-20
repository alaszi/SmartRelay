import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import type { ModuleContext, RelayModule } from './module';
import { createSafeHttpClient } from './safe-http';
import { renderTemplate, TemplateError } from './template';

// A throwaway adapter written only against the contract: it proves the pieces (config schema,
// template engine, SafeHttpClient, price kind) compose without any pipeline special-casing.
const configSchema = z.object({ url: z.string(), template: z.string() });
type Config = z.infer<typeof configSchema>;

const webhookModule: RelayModule<Config> = {
  type: 'email_api',
  configSchema,
  priceKind: () => 'relay_http',
  sampleInput: () => ({ name: 'Ana' }),
  async execute({ config, payload, ctx }) {
    let body: string;
    try {
      body = renderTemplate(config.template, payload);
    } catch (error) {
      if (error instanceof TemplateError) {
        return { ok: false, retryable: false, errorCode: error.code, message: error.message };
      }
      throw error;
    }
    const response = await ctx.http.request({ url: config.url, method: 'POST', body });
    return response.status < 300
      ? { ok: true, statusCode: response.status, request: { body }, response: response.body }
      : {
          ok: false,
          retryable: response.status >= 500 || response.status === 429,
          errorCode: 'DESTINATION_ERROR',
          message: `Destination answered ${response.status}`,
          statusCode: response.status,
        };
  },
};

const ctx = (http: ModuleContext['http']): ModuleContext => ({
  eventId: 'evt_1',
  userTimezone: 'Europe/Bucharest',
  http,
  now: new Date('2026-01-01T00:00:00Z'),
});

describe('RelayModule contract', () => {
  it('validates config with the shared schema and reports its price kind', () => {
    const config = webhookModule.configSchema.parse({ url: 'https://example.com', template: 'x' });
    expect(webhookModule.priceKind(config)).toBe('relay_http');
    expect(() => webhookModule.configSchema.parse({ url: 1 })).toThrow();
  });

  it('turns a template error into a terminal failure result', async () => {
    const result = await webhookModule.execute({
      config: { url: 'https://example.com', template: 'Hi {{$.missing}}' },
      payload: webhookModule.sampleInput(),
      ctx: ctx(createSafeHttpClient()),
    });

    expect(result).toMatchObject({
      ok: false,
      retryable: false,
      errorCode: 'TEMPLATE_VAR_MISSING',
    });
  });

  it('reaches destinations only through the injected SafeHttpClient', async () => {
    const calls: string[] = [];
    const http: ModuleContext['http'] = {
      request: async (request) => {
        calls.push(`${request.method} ${request.body}`);
        return { status: 200, headers: {}, body: 'ok', truncated: false };
      },
    };

    const result = await webhookModule.execute({
      config: { url: 'https://example.com/hook', template: 'Hello {{$.name}}' },
      payload: webhookModule.sampleInput(),
      ctx: ctx(http),
    });

    expect(result).toMatchObject({ ok: true, statusCode: 200 });
    expect(calls).toEqual(['POST Hello Ana']);
  });
});
