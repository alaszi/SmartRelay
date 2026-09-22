import type { ErrorCode } from '@smartrelay/shared';

/** Routes throw this for any expected failure; the global handler maps it to the standard shape. */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode | string;
  readonly fields: Record<string, string> | undefined;

  constructor(
    statusCode: number,
    code: ErrorCode | string,
    message: string,
    fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.fields = fields;
  }
}
