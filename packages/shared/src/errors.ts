import { z } from 'zod';

/** Stable machine-readable codes. Never rename a code once it is stored or returned. */
export const ERROR_CODES = {
  TEMPLATE_SYNTAX: 'TEMPLATE_SYNTAX',
  TEMPLATE_VAR_MISSING: 'TEMPLATE_VAR_MISSING',
  JSONPATH_INVALID: 'JSONPATH_INVALID',
  INVALID_PHONE: 'INVALID_PHONE',
  INVALID_URL: 'INVALID_URL',
  SSRF_BLOCKED: 'SSRF_BLOCKED',
  HTTP_TIMEOUT: 'HTTP_TIMEOUT',
  HTTP_NETWORK: 'HTTP_NETWORK',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Standard API error body: `{ error: { code, message, fields? } }`. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    fields: z.record(z.string(), z.string()).optional(),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
