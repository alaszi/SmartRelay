import { findUserById, findValidSession, type UserRow } from '@smartrelay/db';
import { hashToken } from '@smartrelay/engine';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from './context';
import { HttpError } from './http-error';

export const SESSION_COOKIE = 'sr_session';
const SESSION_COOKIE_MAX_AGE_S = 30 * 24 * 3600;

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: SESSION_COOKIE_MAX_AGE_S,
  });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/', secure, sameSite: 'lax', httpOnly: true });
}

/** Resolves the caller's session and user, or null if the cookie is missing/invalid/expired. */
export async function resolveSession(
  ctx: AppContext,
  request: FastifyRequest,
): Promise<{ user: UserRow } | null> {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;

  const session = await findValidSession(ctx.db, hashToken(token));
  if (!session) return null;

  const user = await findUserById(ctx.db, session.userId);
  return user ? { user } : null;
}

/** preHandler: rejects with 401 unless a valid session cookie is present. */
export function requireAuth(ctx: AppContext) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const resolved = await resolveSession(ctx, request);
    if (!resolved) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in required');
    request.authUser = resolved.user;
  };
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: UserRow;
  }
}
