import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from './http-error';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defense for cookie-authenticated routes (MASTER_PLAN section 8.5): SameSite=Lax already
 * stops the cookie being sent on a cross-site POST from a normal browser; this Origin check is
 * the second layer for state-changing requests, and also catches non-browser or legacy clients
 * that might ignore SameSite. `appOrigin` is the API's own allowed origin (APP_URL).
 */
export function requireSameOrigin(appOrigin: string) {
  return (request: FastifyRequest, _reply: FastifyReply, done: (error?: Error) => void): void => {
    if (SAFE_METHODS.has(request.method)) {
      done();
      return;
    }
    const origin = request.headers.origin;
    if (origin !== appOrigin) {
      done(new HttpError(403, 'CSRF_REJECTED', 'Request origin is not allowed'));
      return;
    }
    done();
  };
}
