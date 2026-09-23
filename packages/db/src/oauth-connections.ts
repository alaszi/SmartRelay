import { randomUUID } from 'node:crypto';
import type { Keyring } from '@smartrelay/engine';
import type { OAuthProvider } from '@smartrelay/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from './client';
import { oauthConnections } from './schema';

export type OAuthConnectionRow = typeof oauthConnections.$inferSelect;
/** Row with `refreshToken` always stripped: the API never returns it (write-only, like a relay's
 * config_secret). */
export type OAuthConnectionPublicRow = Omit<OAuthConnectionRow, 'refreshToken'>;

function toPublic(row: OAuthConnectionRow): OAuthConnectionPublicRow {
  const { refreshToken: _refreshToken, ...rest } = row;
  return rest;
}

export interface UpsertOAuthConnectionInput {
  userId: string;
  provider: OAuthProvider;
  accountEmail: string;
  /** Plaintext; encrypted before storage and never returned. */
  refreshToken: string;
  scopes: string[];
}

/**
 * Stores a freshly-authorized connection (MASTER_PLAN `GET /api/oauth/google/callback`).
 * Reconnecting the same (user, provider, account) — the whole reason the authorize URL always
 * forces `prompt=consent` — replaces its refresh token and scopes rather than erroring, since the
 * old token may already be invalid by the time the user re-authorizes.
 */
export async function upsertOAuthConnection(
  db: Db,
  keyring: Keyring,
  input: UpsertOAuthConnectionInput,
): Promise<OAuthConnectionPublicRow> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(oauthConnections)
      .where(
        and(
          eq(oauthConnections.userId, input.userId),
          eq(oauthConnections.provider, input.provider),
          eq(oauthConnections.accountEmail, input.accountEmail),
        ),
      )
      .limit(1);

    if (existing) {
      const [row] = await tx
        .update(oauthConnections)
        .set({
          refreshToken: keyring.encrypt(input.refreshToken, `oauth:${existing.id}`),
          scopes: input.scopes,
        })
        .where(eq(oauthConnections.id, existing.id))
        .returning();
      if (!row) throw new Error('oauth connection update returned no row');
      return toPublic(row);
    }

    // Generated up front so the encrypted token's AAD (the connection id) is bound from the
    // first write, same pattern as createRelay().
    const id = randomUUID();
    const [row] = await tx
      .insert(oauthConnections)
      .values({
        id,
        userId: input.userId,
        provider: input.provider,
        accountEmail: input.accountEmail,
        refreshToken: keyring.encrypt(input.refreshToken, `oauth:${id}`),
        scopes: input.scopes,
      })
      .returning();
    if (!row) throw new Error('oauth connection insert returned no row');
    return toPublic(row);
  });
}

export async function listOAuthConnectionsForUser(
  db: Db,
  userId: string,
  provider: OAuthProvider,
): Promise<OAuthConnectionPublicRow[]> {
  const rows = await db
    .select()
    .from(oauthConnections)
    .where(and(eq(oauthConnections.userId, userId), eq(oauthConnections.provider, provider)));
  return rows.map(toPublic);
}

/** Internal only: includes the encrypted refresh token, still scoped to the owning user. */
export async function getOAuthConnectionForUser(
  db: Db,
  userId: string,
  id: string,
): Promise<OAuthConnectionRow | undefined> {
  const [row] = await db
    .select()
    .from(oauthConnections)
    .where(and(eq(oauthConnections.id, id), eq(oauthConnections.userId, userId)))
    .limit(1);
  return row;
}

export function decryptOAuthRefreshToken(keyring: Keyring, connection: OAuthConnectionRow): string {
  return keyring.decrypt(connection.refreshToken, `oauth:${connection.id}`);
}
