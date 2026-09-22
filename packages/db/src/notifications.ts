import { and, eq } from 'drizzle-orm';
import type { Executor } from './client';
import { notifications } from './schema';

/**
 * Records that a notification of `kind` was sent for `dedupeKey`, unless one was already recorded
 * (unique on user_id + dedupe_key). Returns true when this call is the one that gets to send the
 * email, so callers should send only when this returns true.
 */
export async function tryRecordNotification(
  db: Executor,
  input: { userId: string; kind: string; dedupeKey: string },
): Promise<boolean> {
  const [row] = await db
    .insert(notifications)
    .values({ userId: input.userId, kind: input.kind, dedupeKey: input.dedupeKey })
    .onConflictDoNothing()
    .returning({ id: notifications.id });
  return row !== undefined;
}

export async function clearNotification(
  db: Executor,
  input: { userId: string; dedupeKey: string },
): Promise<void> {
  await db
    .delete(notifications)
    .where(
      and(eq(notifications.userId, input.userId), eq(notifications.dedupeKey, input.dedupeKey)),
    );
}
