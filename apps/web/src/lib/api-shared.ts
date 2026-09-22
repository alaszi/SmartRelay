/** Mirrors apps/api's standard error body: `{ error: { code, message, fields? } }`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: Record<string, string> | undefined;

  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export async function parseApiResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  const data: unknown = text.length > 0 ? JSON.parse(text) : undefined;

  if (!res.ok) {
    const body = data as
      { error?: { code?: string; message?: string; fields?: Record<string, string> } } | undefined;
    throw new ApiError(
      res.status,
      body?.error?.code ?? 'UNKNOWN',
      body?.error?.message ?? res.statusText,
      body?.error?.fields,
    );
  }
  return data as T;
}

export function jsonHeaders(init: RequestInit, extra?: HeadersInit): Headers {
  const headers = new Headers(init.headers);
  if (extra) new Headers(extra).forEach((value, key) => headers.set(key, value));
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return headers;
}
