import pino, { type Logger } from 'pino';

/**
 * Redaction list from MASTER_PLAN section 7: never log payloads, tokens or secrets. Matches by
 * key name anywhere in the object (the leading `*` wildcard), so it also covers nested fields
 * like `body.configSecret` or `context.payloadIn` without listing every possible path.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.ingestToken',
  '*.secret',
  '*.configSecret',
  '*.payload',
  '*.payloadIn',
  '*.payloadOut',
  '*.authorization',
];

export function createLogger(nodeEnv: string): Logger {
  return pino({
    level: nodeEnv === 'production' ? 'info' : 'debug',
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    ...(nodeEnv === 'production' ? {} : { transport: { target: 'pino-pretty' } }),
  });
}
