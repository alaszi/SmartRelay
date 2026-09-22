import { and, eq, gt, lt, ne } from 'drizzle-orm';
import type { Executor } from './client';
import { sessions } from './schema';

export type SessionRow = typeof sessions.$inferSelect;

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

/** `idHash` is the SHA-256 of the raw session token; only the hash is ever stored. */
export async function createSession(
  db: Executor,
  input: { idHash: string; userId: string },
): Promise<SessionRow> {
  const [session] = await db
    .insert(sessions)
    .values({
      id: input.idHash,
      userId: input.userId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    })
    .returning();
  if (!session) throw new Error('session insert returned no row');
  return session;
}

/** Returns the session only if it exists and has not expired. */
export async function findValidSession(
  db: Executor,
  idHash: string,
): Promise<SessionRow | undefined> {
  const [session] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.id, idHash), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return session;
}

export async function deleteSession(db: Executor, idHash: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, idHash));
}

/** Session rotation on login (MASTER_PLAN section 8.5): every other session for the user ends. */
export async function deleteOtherSessions(
  db: Executor,
  userId: string,
  keepIdHash?: string,
): Promise<void> {
  await db
    .delete(sessions)
    .where(
      keepIdHash === undefined
        ? eq(sessions.userId, userId)
        : and(eq(sessions.userId, userId), ne(sessions.id, keepIdHash)),
    );
}

export async function deleteExpiredSessions(db: Executor): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}
