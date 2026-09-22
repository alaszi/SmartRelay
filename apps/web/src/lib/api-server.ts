import 'server-only';
import { cookies } from 'next/headers';
import { ApiError, jsonHeaders, parseApiResponse } from './api-shared';

// Server-to-server address (the Next.js process, not the browser): in prod this is the api
// container's internal address, distinct from the public same-origin /api/* path Nginx exposes
// to the browser (MASTER_PLAN section 3).
const API_INTERNAL_URL = process.env['API_INTERNAL_URL'] ?? 'http://localhost:3001';

/** For Server Components: forwards the incoming request's cookies so the API sees the same
 * session, and always bypasses Next's fetch cache (this is per-user data). */
export async function apiFetchServer<T>(path: string, init: RequestInit = {}): Promise<T> {
  const jar = await cookies();
  const cookieHeader = jar
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const headers = jsonHeaders(init, cookieHeader ? { cookie: cookieHeader } : undefined);

  const res = await fetch(`${API_INTERNAL_URL}${path}`, { ...init, headers, cache: 'no-store' });
  return parseApiResponse<T>(res);
}

export interface CurrentUser {
  id: string;
  email: string;
  emailVerified: boolean;
  balance: string;
}

/** Null when there is no valid session, rather than throwing: every protected page needs this
 * check, and "not signed in" is routine, not exceptional. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  try {
    return await apiFetchServer<CurrentUser>('/api/me');
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}
