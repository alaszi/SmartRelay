import { and, eq, gt, isNotNull, sql } from 'drizzle-orm';
import type { Executor } from './client';
import { users } from './schema';

export interface UserDeletionSummary {
  relayCount: number;
  eventCount: number;
  oauthConnectionCount: number;
  sessionCount: number;
}

/** What `deleteUser` below would remove, without removing it — for a confirmation prompt. */
export async function previewUserDeletion(
  db: Executor,
  userId: string,
): Promise<UserDeletionSummary> {
  const result = await db.execute<{
    relay_count: number;
    event_count: number;
    oauth_connection_count: number;
    session_count: number;
  }>(sql`
    select
      (select count(*)::int from relays where user_id = ${userId}) as relay_count,
      (select count(*)::int from events where user_id = ${userId}) as event_count,
      (select count(*)::int from oauth_connections where user_id = ${userId}) as oauth_connection_count,
      (select count(*)::int from sessions where user_id = ${userId}) as session_count
  `);
  const row = result.rows[0];
  return {
    relayCount: row?.relay_count ?? 0,
    eventCount: row?.event_count ?? 0,
    oauthConnectionCount: row?.oauth_connection_count ?? 0,
    sessionCount: row?.session_count ?? 0,
  };
}

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

/**
 * GDPR account deletion (MASTER_PLAN section 7 & 12, `pnpm admin:delete-user`): removes all of a
 * user's data except ledger rows required for accounting, which survive anonymized. A single
 * `DELETE FROM users` achieves both halves by design — every foreign key into `users` is
 * `ON DELETE CASCADE` (sessions, relays and everything under them, oauth_connections, events and
 * their payloads/delivery attempts, notifications) except `credit_ledger.user_id` and
 * `topups.user_id`, which are `ON DELETE SET NULL` (see `packages/db/drizzle/0001_initial_schema.sql`)
 * so those rows survive with their amounts and timestamps intact but no longer linked to a person.
 */
export async function deleteUser(db: Executor, userId: string): Promise<void> {
  await db.delete(users).where(eq(users.id, userId));
}
