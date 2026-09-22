import {
  consumeEmailVerifyToken,
  consumePasswordResetToken,
  createSession,
  createUser,
  deleteOtherSessions,
  deleteSession,
  findUserByEmail,
  getBalance,
  setEmailVerifyToken,
  setPasswordResetToken,
} from '@smartrelay/db';
import { generateToken, hashPassword, hashToken, verifyPassword } from '@smartrelay/engine';
import { formatMicroEur } from '@smartrelay/shared';
import type { preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { App } from '../app';
import type { AppContext } from '../context';
import { HttpError } from '../http-error';
import { clearSessionCookie, requireAuth, SESSION_COOKIE, setSessionCookie } from '../session';

const registerSchema = z.object({ email: z.email(), password: z.string().min(8).max(200) });
const loginSchema = z.object({ email: z.email(), password: z.string().min(1).max(200) });
const verifyEmailSchema = z.object({ token: z.string().min(1) });
const forgotSchema = z.object({ email: z.email() });
const resetSchema = z.object({ token: z.string().min(1), password: z.string().min(8).max(200) });

// A password never verifies against this hash; used so login timing does not reveal whether the
// email exists (argon2 verification of a real hash always runs, win or lose). Computed once, on
// first use, rather than hand-written, because a syntactically invalid hash makes verify() throw.
let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(generateToken());
  return dummyHash;
}

async function newSession(ctx: AppContext, userId: string): Promise<string> {
  const token = generateToken();
  await createSession(ctx.db, { idHash: hashToken(token), userId });
  return token;
}

export function registerAuthRoutes(
  app: App,
  ctx: AppContext,
  options: { secureCookies: boolean; sameOrigin: preHandlerHookHandler },
): void {
  const { secureCookies, sameOrigin } = options;

  app.post(
    '/api/auth/register',
    { preHandler: sameOrigin, schema: { body: registerSchema } },
    async (request, reply) => {
      const { email, password } = request.body;
      const user = await createUser(ctx.db, { email, passwordHash: await hashPassword(password) });

      const verifyToken = generateToken();
      await setEmailVerifyToken(ctx.db, user.id, hashToken(verifyToken));
      await ctx.mailer.send({
        to: user.email,
        subject: 'Verify your SmartRelay account',
        text: `Verify your email: ${ctx.env.APP_URL}/verify-email?token=${verifyToken}`,
      });

      const session = await newSession(ctx, user.id);
      setSessionCookie(reply, session, secureCookies);
      reply.status(201);
      return { id: user.id, email: user.email };
    },
  );

  app.post(
    '/api/auth/login',
    {
      preHandler: sameOrigin,
      schema: { body: loginSchema },
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
          // Runs after body parsing/validation (the default 'onRequest' hook runs before it, when
          // request.body is not yet available) so the key can include the attempted email.
          hook: 'preHandler',
          keyGenerator: (request) =>
            `login:${request.ip}:${(request.body as { email?: string }).email ?? ''}`,
        },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body;
      const user = await findUserByEmail(ctx.db, email);
      const ok = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()));
      if (!user || !ok)
        throw new HttpError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');

      // A fresh session token is issued on every login (session rotation), never reused.
      const session = await newSession(ctx, user.id);
      setSessionCookie(reply, session, secureCookies);
      return { id: user.id, email: user.email };
    },
  );

  app.post(
    '/api/auth/logout',
    { preHandler: [sameOrigin, requireAuth(ctx)] },
    async (request, reply) => {
      const token = request.cookies[SESSION_COOKIE];
      if (token) await deleteSession(ctx.db, hashToken(token));
      clearSessionCookie(reply, secureCookies);
      reply.status(204);
    },
  );

  app.post(
    '/api/auth/verify-email',
    { preHandler: sameOrigin, schema: { body: verifyEmailSchema } },
    async (request) => {
      await consumeEmailVerifyToken(ctx.db, hashToken(request.body.token));
      return { verified: true };
    },
  );

  app.post(
    '/api/auth/forgot',
    { preHandler: sameOrigin, schema: { body: forgotSchema } },
    async (request) => {
      const user = await findUserByEmail(ctx.db, request.body.email);
      if (user) {
        const resetToken = generateToken();
        await setPasswordResetToken(ctx.db, user.id, hashToken(resetToken));
        await ctx.mailer.send({
          to: user.email,
          subject: 'Reset your SmartRelay password',
          text: `Reset your password: ${ctx.env.APP_URL}/reset-password?token=${resetToken}`,
        });
      }
      // Same response whether or not the email exists, so a caller cannot enumerate accounts.
      return { sent: true };
    },
  );

  app.post(
    '/api/auth/reset',
    { preHandler: sameOrigin, schema: { body: resetSchema } },
    async (request) => {
      const user = await consumePasswordResetToken(
        ctx.db,
        hashToken(request.body.token),
        await hashPassword(request.body.password),
      );
      // A password reset ends every existing session, not just the one making this request.
      await deleteOtherSessions(ctx.db, user.id);
      return { reset: true };
    },
  );

  app.get('/api/me', { preHandler: requireAuth(ctx) }, async (request) => {
    const user = request.authUser!;
    const balance = await getBalance(ctx.db, user.id);
    return {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerifiedAt !== null,
      balance: formatMicroEur(balance),
    };
  });
}
