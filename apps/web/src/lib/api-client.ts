'use client';

import { jsonHeaders, parseApiResponse } from './api-shared';

/** For Client Components: same-origin `/api/*`, proxied to the Fastify API (dev: next.config.ts
 * rewrite; prod: Nginx). Cookies ride along automatically since the request is same-origin. */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, headers: jsonHeaders(init) });
  return parseApiResponse<T>(res);
}
