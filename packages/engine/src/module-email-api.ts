import { LIMITS } from '@smartrelay/shared';
import { z } from 'zod';
import { queryFirst } from './jsonpath';
import type { RelayModule } from './module';

export interface NormalizedInboundEmail {
  from: string;
  to: string;
  subject: string;
  /** ISO 8601. */
  receivedAt: string;
  messageId: string;
  text: string;
  html?: string;
  /** Lower-cased header names; the first value when a header repeats. */
  headers: Record<string, string>;
}

export interface EmailApiPayload {
  meta: { from: string; to: string; subject: string; receivedAt: string; messageId: string };
  fields: Record<string, string>;
  raw: { text: string; html?: string };
}

/** Naive "Key: Value" line parser for the default (no parsing rules) output. */
function parseKeyValueLines(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([^:]+):[ \t]*(.*)$/.exec(line);
    const key = match?.[1]?.trim();
    if (key) fields[key] = (match?.[2] ?? '').trim();
  }
  return fields;
}

/** MASTER_PLAN section 6, Module 2: "Default output (no rules)". Body is capped by the caller. */
export function buildDefaultEmailPayload(email: NormalizedInboundEmail): EmailApiPayload {
  return {
    meta: {
      from: email.from,
      to: email.to,
      subject: email.subject,
      receivedAt: email.receivedAt,
      messageId: email.messageId,
    },
    fields: parseKeyValueLines(email.text),
    raw: { text: email.text, ...(email.html === undefined ? {} : { html: email.html }) },
  };
}

export interface EmailFilter {
  subjectContains?: string;
  senderEquals?: string;
}

/** MASTER_PLAN section 6, Module 2, Advanced "filter": non-matching mail is REJECTED, not billed. */
export function matchesEmailFilter(
  email: NormalizedInboundEmail,
  filter: EmailFilter | undefined,
): boolean {
  if (!filter) return true;
  if (filter.subjectContains && !email.subject.includes(filter.subjectContains)) return false;
  if (filter.senderEquals && email.from.toLowerCase() !== filter.senderEquals.toLowerCase())
    return false;
  return true;
}

/**
 * MASTER_PLAN section 6, Module 2, "Loop protection": drop mail with `Auto-Submitted` != `no`,
 * `Precedence: bulk/auto_reply`, or sent from the platform's own domain.
 */
export function isLoopedEmail(email: NormalizedInboundEmail, platformDomain: string): boolean {
  const autoSubmitted = email.headers['auto-submitted'];
  if (autoSubmitted !== undefined && autoSubmitted.toLowerCase() !== 'no') return true;

  const precedence = email.headers['precedence']?.toLowerCase();
  if (precedence === 'bulk' || precedence === 'auto_reply') return true;

  const senderDomain = email.from.split('@')[1]?.toLowerCase();
  if (senderDomain !== undefined && senderDomain === platformDomain.toLowerCase()) return true;

  return false;
}

// ---------------------------------------------------------------------------------------------
// The module: turns the default output (+ optional Advanced parsing rules) into one JSON POST.
// ---------------------------------------------------------------------------------------------

const parsingRuleSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['jsonpath', 'regex']),
  expression: z.string().min(1).max(LIMITS.maxJsonPathLength),
});

export const emailApiConfigSchema = z.object({
  targetUrl: z.url(),
  parsingRules: z.array(parsingRuleSchema).max(50).default([]),
  filter: z
    .object({
      subjectContains: z.string().min(1).optional(),
      senderEquals: z.string().min(1).optional(),
    })
    .optional(),
});

export type EmailApiConfig = z.infer<typeof emailApiConfigSchema>;

/**
 * Applies Advanced parsing rules on top of the default fields: a `jsonpath` rule reads from the
 * default-output payload itself (e.g. `$.raw.text`) into a field named after the rule; a `regex`
 * rule matches against the text body and merges in its named capture groups directly (a single
 * regex rule can therefore populate several fields at once).
 */
function applyParsingRules(
  payload: EmailApiPayload,
  rules: EmailApiConfig['parsingRules'],
): Record<string, string> {
  if (rules.length === 0) return payload.fields;

  const fields: Record<string, string> = { ...payload.fields };
  for (const rule of rules) {
    if (rule.type === 'jsonpath') {
      const result = queryFirst(payload, rule.expression);
      if (result.found) {
        fields[rule.name] =
          typeof result.value === 'string' ? result.value : JSON.stringify(result.value);
      }
    } else {
      const match = new RegExp(rule.expression).exec(payload.raw.text);
      if (match?.groups) Object.assign(fields, match.groups);
    }
  }
  return fields;
}

/** Module 2: Email -> API Parser (MASTER_PLAN section 6). Always priced as `relay_http`. */
export const emailApiModule: RelayModule<EmailApiConfig> = {
  type: 'email_api',
  configSchema: emailApiConfigSchema,
  priceKind: () => 'relay_http',
  sampleInput: () =>
    buildDefaultEmailPayload({
      from: 'customer@example.com',
      to: 'r_abc12345@inbound.smartrelay.ro',
      subject: 'New order #1042',
      receivedAt: new Date().toISOString(),
      messageId: '<abc123@mail.example.com>',
      text: 'Name: Ana\nOrder: 1042\nTotal: 49.90',
      headers: {},
    }),

  async execute({ config, payload, ctx }) {
    const email = payload as EmailApiPayload;
    const fields = applyParsingRules(email, config.parsingRules);
    const body = JSON.stringify({ meta: email.meta, fields, raw: email.raw });

    const response = await ctx.http.request({
      url: config.targetUrl,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

    if (response.status >= 200 && response.status < 300) {
      return { ok: true, statusCode: response.status, request: { body }, response: response.body };
    }
    return {
      ok: false,
      retryable: response.status >= 500 || response.status === 429,
      errorCode: 'DESTINATION_ERROR',
      message: `Destination answered ${response.status}`,
      statusCode: response.status,
      request: { body },
      response: response.body,
    };
  },
};
