import { z } from 'zod';

/** Stable machine-readable codes. Never rename a code once it is stored or returned. */
export const ERROR_CODES = {
  TEMPLATE_SYNTAX: 'TEMPLATE_SYNTAX',
  TEMPLATE_VAR_MISSING: 'TEMPLATE_VAR_MISSING',
  JSONPATH_INVALID: 'JSONPATH_INVALID',
  INVALID_PHONE: 'INVALID_PHONE',
  INVALID_URL: 'INVALID_URL',
  INVALID_REQUEST: 'INVALID_REQUEST',
  SSRF_BLOCKED: 'SSRF_BLOCKED',
  HTTP_TIMEOUT: 'HTTP_TIMEOUT',
  HTTP_NETWORK: 'HTTP_NETWORK',

  // API-level codes (apps/api).
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  CSRF_REJECTED: 'CSRF_REJECTED',
  BODY_TOO_LARGE: 'BODY_TOO_LARGE',
  UNSUPPORTED_CONTENT_TYPE: 'UNSUPPORTED_CONTENT_TYPE',
  RELAY_NOT_FOUND: 'RELAY_NOT_FOUND',
  RELAY_INACTIVE: 'RELAY_INACTIVE',

  // Module-level codes (packages/engine module adapters).
  RECIPIENT_PATH_MISSING: 'RECIPIENT_PATH_MISSING',
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
