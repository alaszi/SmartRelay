import { randomBytes, randomUUID } from 'node:crypto';
import type { Keyring } from '@smartrelay/engine';
import { generateToken } from '@smartrelay/engine';
import { MAX_RELAYS_PER_ACCOUNT } from '@smartrelay/shared';
import { and, count, eq } from 'drizzle-orm';
import type { Db, Executor } from './client';
import { relayEmailAddresses, relays } from './schema';

export type RelayRow = typeof relays.$inferSelect;
/** Relay row with `configSecret` always stripped: the API never returns it (write-only). The web
 * UI's SecretInput still needs to know whether one is already stored, without its content. */
export type RelayPublicRow = Omit<RelayRow, 'configSecret'> & { hasSecret: boolean };

export type RelayErrorCode = 'LIMIT_REACHED' | 'NOT_FOUND';

export class RelayError extends Error {
  readonly code: RelayErrorCode;

  constructor(code: RelayErrorCode, message: string) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
  }
}

function toPublic(row: RelayRow): RelayPublicRow {
  const { configSecret, ...rest } = row;
  return { ...rest, hasSecret: configSecret !== null };
}

/** 24 random bytes -> 32 base64url characters, meeting the "32+ chars" requirement. */
export function generateIngestToken(): string {
  return generateToken(24);
}

/**
 * `r_<8 chars>@<inboundDomain>` (MASTER_PLAN section 4). Lower-case hex only (4 random bytes),
 * not the usual mixed-case base64url token: SMTP local parts are technically case-sensitive, but
 * many real mail systems normalize case in practice, so an all-lower-case address avoids that
 * entire class of lookup mismatch instead of relying on every provider preserving case exactly.
 */
export function generateInboundEmailAddress(inboundDomain: string): string {
  return `r_${randomBytes(4).toString('hex')}@${inboundDomain.toLowerCase()}`;
}

/** Bearer secret for `POST /tg/:relayId/:secret` (MASTER_PLAN section 6, Module 3, decision D5). */
export function generateTelegramCallbackSecret(): string {
  return generateToken(24);
}

function encryptSecret(
  keyring: Keyring,
  relayId: string,
  secret: Record<string, unknown> | undefined,
): string | null {
  if (secret === undefined || Object.keys(secret).length === 0) return null;
  return keyring.encrypt(JSON.stringify(secret), `relay:${relayId}`);
}

/** Decrypts `relays.config_secret`. Returns {} when the relay has no secret fields set. */
export function decryptRelaySecret(
  keyring: Keyring,
  relay: Pick<RelayRow, 'id' | 'configSecret'>,
): Record<string, unknown> {
  if (relay.configSecret === null) return {};
  return JSON.parse(keyring.decrypt(relay.configSecret, `relay:${relay.id}`)) as Record<
    string,
    unknown
  >;
}

export async function countRelaysForUser(db: Executor, userId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(relays).where(eq(relays.userId, userId));
  return row?.n ?? 0;
}

export interface RelayInput {
  userId: string;
  name: string;
  type: RelayRow['type'];
  configPublic?: Record<string, unknown> | undefined;
  /** Plaintext; encrypted before storage and never returned. */
  configSecret?: Record<string, unknown> | undefined;
  /** Required when type === 'email_api': the domain the auto-generated inbound address is under. */
  inboundDomain?: string | undefined;
}

export async function createRelay(
  db: Db,
  keyring: Keyring,
  input: RelayInput,
): Promise<RelayPublicRow> {
  if (input.type === 'email_api' && !input.inboundDomain) {
    throw new Error('inboundDomain is required to create an email_api relay');
  }

  return db.transaction(async (tx) => {
    const existing = await countRelaysForUser(tx, input.userId);
    if (existing >= MAX_RELAYS_PER_ACCOUNT) {
      throw new RelayError(
        'LIMIT_REACHED',
        `An account may have at most ${MAX_RELAYS_PER_ACCOUNT} relays`,
      );
    }

    // Generated up front so the encrypted secret's AAD (the relay id) is bound from the first write.
    const id = randomUUID();
    const isTelegramChatRelay =
      input.type === 'chat_relay' && input.configPublic?.['platform'] === 'telegram';
    const configSecret = isTelegramChatRelay
      ? { ...input.configSecret, tgCallbackSecret: generateTelegramCallbackSecret() }
      : input.configSecret;
    const [row] = await tx
      .insert(relays)
      .values({
        id,
        userId: input.userId,
        name: input.name,
        type: input.type,
        ingestToken: generateIngestToken(),
        configPublic: input.configPublic ?? {},
        configSecret: encryptSecret(keyring, id, configSecret),
      })
      .returning();
    if (!row) throw new Error('relay insert returned no row');

    if (input.type === 'email_api' && input.inboundDomain) {
      await tx.insert(relayEmailAddresses).values({
        relayId: id,
        address: generateInboundEmailAddress(input.inboundDomain),
      });
    }

    return toPublic(row);
  });
}

export async function listRelaysForUser(db: Executor, userId: string): Promise<RelayPublicRow[]> {
  const rows = await db
    .select()
    .from(relays)
    .where(eq(relays.userId, userId))
    .orderBy(relays.createdAt);
  return rows.map(toPublic);
}

export async function getRelayForUser(
  db: Executor,
  userId: string,
  id: string,
): Promise<RelayPublicRow | undefined> {
  const [row] = await db
    .select()
    .from(relays)
    .where(and(eq(relays.id, id), eq(relays.userId, userId)))
    .limit(1);
  return row ? toPublic(row) : undefined;
}

/** For internal callers only (e.g. the worker): includes the encrypted secret blob. */
export async function getRelayInternal(db: Executor, id: string): Promise<RelayRow | undefined> {
  const [row] = await db.select().from(relays).where(eq(relays.id, id)).limit(1);
  return row;
}

export interface RelayUpdateInput {
  name?: string | undefined;
  status?: RelayRow['status'] | undefined;
  configPublic?: Record<string, unknown> | undefined;
  configSecret?: Record<string, unknown> | undefined;
}

export async function updateRelay(
  db: Db,
  keyring: Keyring,
  userId: string,
  id: string,
  input: RelayUpdateInput,
): Promise<RelayPublicRow> {
  return db.transaction(async (tx) => {
    const set: Partial<typeof relays.$inferInsert> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.status !== undefined) set.status = input.status;
    if (input.configPublic !== undefined) set.configPublic = input.configPublic;

    if (input.configPublic !== undefined || input.configSecret !== undefined) {
      const [existing] = await tx.select().from(relays).where(eq(relays.id, id)).limit(1);
      const existingSecret =
        existing?.configSecret !== null && existing?.configSecret !== undefined
          ? decryptRelaySecret(keyring, existing)
          : {};

      // A "Replace" in the UI only ever supplies the one secret field being changed (secrets are
      // write-only, MASTER_PLAN section 8.1: the client cannot know the others' current values),
      // so this merges onto what is already stored instead of overwriting the whole blob.
      let nextSecret = input.configSecret
        ? { ...existingSecret, ...input.configSecret }
        : undefined;

      // The web wizard creates a relay at step 1 (name + type only) and fills in its destination
      // config later via this same update path, so a telegram chat_relay may only turn into one
      // here rather than at createRelay() — mirror that function's auto-provisioning of the
      // callback secret so it is never missing just because of when the config arrived.
      const platform = (input.configPublic ?? existing?.configPublic)?.['platform'];
      if (existing?.type === 'chat_relay' && platform === 'telegram') {
        const merged = nextSecret ?? existingSecret;
        if (typeof merged['tgCallbackSecret'] !== 'string') {
          nextSecret = { ...merged, tgCallbackSecret: generateTelegramCallbackSecret() };
        }
      }

      if (nextSecret !== undefined) set.configSecret = encryptSecret(keyring, id, nextSecret);
    }

    const [row] = await tx
      .update(relays)
      .set(set)
      .where(and(eq(relays.id, id), eq(relays.userId, userId)))
      .returning();
    if (!row) throw new RelayError('NOT_FOUND', 'Relay not found');
    return toPublic(row);
  });
}

export async function rotateIngestToken(
  db: Executor,
  userId: string,
  id: string,
): Promise<RelayPublicRow> {
  const [row] = await db
    .update(relays)
    .set({ ingestToken: generateIngestToken() })
    .where(and(eq(relays.id, id), eq(relays.userId, userId)))
    .returning();
  if (!row) throw new RelayError('NOT_FOUND', 'Relay not found');
  return toPublic(row);
}

export async function deleteRelay(db: Executor, userId: string, id: string): Promise<void> {
  const [row] = await db
    .delete(relays)
    .where(and(eq(relays.id, id), eq(relays.userId, userId)))
    .returning({ id: relays.id });
  if (!row) throw new RelayError('NOT_FOUND', 'Relay not found');
}

export async function findRelayByIngestToken(
  db: Executor,
  token: string,
): Promise<RelayRow | undefined> {
  const [row] = await db.select().from(relays).where(eq(relays.ingestToken, token)).limit(1);
  return row;
}

export async function touchLastTriggered(db: Executor, id: string): Promise<void> {
  await db.update(relays).set({ lastTriggeredAt: new Date() }).where(eq(relays.id, id));
}

export async function getRelayEmailAddress(
  db: Executor,
  relayId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ address: relayEmailAddresses.address })
    .from(relayEmailAddresses)
    .where(eq(relayEmailAddresses.relayId, relayId))
    .limit(1);
  return row?.address;
}

/** Module 2 (email_api) trigger: maps an inbound email address to its (active or not) relay. */
export async function findRelayByInboundAddress(
  db: Executor,
  address: string,
): Promise<RelayRow | undefined> {
  const [row] = await db
    .select({ relay: relays })
    .from(relayEmailAddresses)
    .innerJoin(relays, eq(relays.id, relayEmailAddresses.relayId))
    .where(eq(relayEmailAddresses.address, address.toLowerCase()))
    .limit(1);
  return row?.relay;
}
