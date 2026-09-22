import { and, eq, gt, isNotNull, sql } from 'drizzle-orm';
import type { Executor } from './client';
import { users } from './schema';

export type UserRow = typeof users.$inferSelect;

export type AuthErrorCode = 'EMAIL_TAKEN' | 'TOKEN_INVALID' | 'TOKEN_EXPIRED';

export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AuthError';
    this.code = code;
  }
}

function isUniqueViolation(error: unknown): boolean {
  // Postgres error code 23505 = unique_violation. Drizzle wraps the pg error in a
  // DrizzleQueryError, so the code may be on the error itself or on its `cause`.
  const err = error as { code?: string; cause?: { code?: string } } | null;
  return err?.code === '23505' || err?.cause?.code === '23505';
}

export async function createUser(
  db: Executor,
  input: { email: string; passwordHash: string },
): Promise<UserRow> {
  try {
    const [user] = await db.insert(users).values(input).returning();
    if (!user) throw new Error('user insert returned no row');
    return user;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AuthError('EMAIL_TAKEN', 'An account with this email already exists', {
        cause: error,
      });
    }
    throw error;
  }
}

export async function findUserByEmail(db: Executor, email: string): Promise<UserRow | undefined> {
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return user;
}

export async function findUserById(db: Executor, id: string): Promise<UserRow | undefined> {
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return user;
}

const EMAIL_VERIFY_TTL_MS = 24 * 3600 * 1000;
const PASSWORD_RESET_TTL_MS = 1 * 3600 * 1000;

/** Stores a hashed, time-limited token and returns it (the raw token is never persisted). */
export async function setEmailVerifyToken(
  db: Executor,
  userId: string,
  tokenHash: string,
): Promise<void> {
  await db
    .update(users)
    .set({
      emailVerifyTokenHash: tokenHash,
      emailVerifyExpiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_MS),
    })
    .where(eq(users.id, userId));
}

/** Verifies the email for the user owning this token hash, consuming it. Idempotent per call. */
export async function consumeEmailVerifyToken(db: Executor, tokenHash: string): Promise<UserRow> {
  const [user] = await db
    .update(users)
    .set({ emailVerifiedAt: sql`now()`, emailVerifyTokenHash: null, emailVerifyExpiresAt: null })
    .where(
      and(
        eq(users.emailVerifyTokenHash, tokenHash),
        isNotNull(users.emailVerifyExpiresAt),
        gt(users.emailVerifyExpiresAt, sql`now()`),
      ),
    )
    .returning();
  if (!user) throw new AuthError('TOKEN_INVALID', 'Verification link is invalid or has expired');
  return user;
}

export async function setPasswordResetToken(
  db: Executor,
  userId: string,
  tokenHash: string,
): Promise<void> {
  await db
    .update(users)
    .set({
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
    })
    .where(eq(users.id, userId));
}

/** Sets a new password for the user owning this reset token hash, consuming it. */
export async function consumePasswordResetToken(
  db: Executor,
  tokenHash: string,
  newPasswordHash: string,
): Promise<UserRow> {
  const [user] = await db
    .update(users)
    .set({
      passwordHash: newPasswordHash,
      passwordResetTokenHash: null,
      passwordResetExpiresAt: null,
    })
    .where(
      and(
        eq(users.passwordResetTokenHash, tokenHash),
        isNotNull(users.passwordResetExpiresAt),
        gt(users.passwordResetExpiresAt, sql`now()`),
      ),
    )
    .returning();
  if (!user) throw new AuthError('TOKEN_INVALID', 'Reset link is invalid or has expired');
  return user;
}
