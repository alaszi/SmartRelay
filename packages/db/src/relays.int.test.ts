import { randomBytes } from 'node:crypto';
import { Keyring } from '@smartrelay/engine';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, createUser, resetDb } from '../test/helpers';
import type { DbHandle } from './client';
import {
  countRelaysForUser,
  createRelay,
  decryptRelaySecret,
  deleteRelay,
  findRelayByIngestToken,
  generateIngestToken,
  getRelayForUser,
  getRelayInternal,
  listRelaysForUser,
  RelayError,
  rotateIngestToken,
  touchLastTriggered,
  updateRelay,
} from './relays';

let handle: DbHandle;
let keyring: Keyring;

beforeAll(() => {
  handle = createTestDb();
  keyring = new Keyring({ id: 'k1', key: randomBytes(32) });
});
afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await resetDb(handle.db);
});

describe('generateIngestToken', () => {
  it('produces 32+ char base64url tokens with no collisions', () => {
    const tokens = new Set(Array.from({ length: 100 }, generateIngestToken));
    expect(tokens.size).toBe(100);
    for (const token of tokens) {
      expect(token.length).toBeGreaterThanOrEqual(32);
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});

describe('createRelay', () => {
  it('creates a relay with defaults and never returns configSecret', async () => {
    const user = await createUser(handle.db);

    const relay = await createRelay(handle.db, keyring, {
      userId: user.id,
      name: 'My Shop',
      type: 'webhook_sms',
    });

    expect(relay.status).toBe('active');
    expect(relay.smsMode).toBe('byo');
    expect(relay.configPublic).toEqual({});
    expect('configSecret' in relay).toBe(false);
    expect(relay.ingestToken).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  });

  it('encrypts the secret config and it round-trips through decryptRelaySecret', async () => {
    const user = await createUser(handle.db);
    const relay = await createRelay(handle.db, keyring, {
      userId: user.id,
      name: 'SMS relay',
      type: 'webhook_sms',
      configPublic: { provider: 'smslink' },
      configSecret: { apiKey: 'super-secret-key' },
    });

    const stored = await getRelayInternal(handle.db, relay.id);
    expect(stored?.configSecret).not.toBeNull();
    expect(stored?.configSecret).not.toContain('super-secret-key');

    expect(decryptRelaySecret(keyring, stored!)).toEqual({ apiKey: 'super-secret-key' });
  });

  it('stores no secret blob when configSecret is omitted or empty', async () => {
    const user = await createUser(handle.db);
    const a = await createRelay(handle.db, keyring, {
      userId: user.id,
      name: 'a',
      type: 'chat_relay',
    });
    const b = await createRelay(handle.db, keyring, {
      userId: user.id,
      name: 'b',
      type: 'chat_relay',
      configSecret: {},
    });

    expect((await getRelayInternal(handle.db, a.id))?.configSecret).toBeNull();
    expect((await getRelayInternal(handle.db, b.id))?.configSecret).toBeNull();
  });

  it('binds the encrypted secret to its own relay id (AAD)', async () => {
    const user = await createUser(handle.db);
    const relay = await createRelay(handle.db, keyring, {
      userId: user.id,
      name: 'x',
      type: 'webhook_sms',
      configSecret: { apiKey: 'k' },
    });
    const other = await createRelay(handle.db, keyring, {
      userId: user.id,
      name: 'y',
      type: 'chat_relay',
    });

    const stolen = (await getRelayInternal(handle.db, relay.id))!;
    expect(() =>
      decryptRelaySecret(keyring, { id: other.id, configSecret: stolen.configSecret }),
    ).toThrow();
  });

  it('enforces the 25-relay limit per account', async () => {
    const user = await createUser(handle.db);
    for (let i = 0; i < 25; i++) {
      await createRelay(handle.db, keyring, { userId: user.id, name: `r${i}`, type: 'chat_relay' });
    }
    expect(await countRelaysForUser(handle.db, user.id)).toBe(25);

    await expect(
      createRelay(handle.db, keyring, {
        userId: user.id,
        name: 'one too many',
        type: 'chat_relay',
      }),
    ).rejects.toMatchObject({ code: 'LIMIT_REACHED' });
  });

  it("does not count another user's relays toward the limit", async () => {
    const a = await createUser(handle.db);
    const b = await createUser(handle.db);
    await createRelay(handle.db, keyring, { userId: a.id, name: 'a', type: 'chat_relay' });

    expect(await countRelaysForUser(handle.db, b.id)).toBe(0);
    await expect(
      createRelay(handle.db, keyring, { userId: b.id, name: 'b', type: 'chat_relay' }),
    ).resolves.toBeDefined();
  });
});

describe('listRelaysForUser / getRelayForUser', () => {
  it("lists only the caller's relays and never leaks configSecret", async () => {
    const alice = await createUser(handle.db);
    const bob = await createUser(handle.db);
    await createRelay(handle.db, keyring, {
      userId: alice.id,
      name: 'alice-relay',
      type: 'webhook_sms',
      configSecret: { apiKey: 'secret' },
    });
    await createRelay(handle.db, keyring, {
      userId: bob.id,
      name: 'bob-relay',
      type: 'chat_relay',
    });

    const list = await listRelaysForUser(handle.db, alice.id);
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('alice-relay');
    expect(JSON.stringify(list)).not.toContain('secret');
  });

  it('scopes getRelayForUser to the owner', async () => {
    const alice = await createUser(handle.db);
    const bob = await createUser(handle.db);
    const relay = await createRelay(handle.db, keyring, {
      userId: alice.id,
      name: 'x',
      type: 'chat_relay',
    });

    expect(await getRelayForUser(handle.db, alice.id, relay.id)).toMatchObject({ id: relay.id });
    expect(await getRelayForUser(handle.db, bob.id, relay.id)).toBeUndefined();
  });
});

describe('updateRelay', () => {
  it('updates only the given fields and re-encrypts a new secret', async () => {
    const user = await createUser(handle.db);
    const relay = await createRelay(handle.db, keyring, {
      userId: user.id,
      name: 'old name',
      type: 'webhook_sms',
      configSecret: { apiKey: 'old-key' },
    });

    const updated = await updateRelay(handle.db, keyring, user.id, relay.id, {
      name: 'new name',
      status: 'inactive',
      configSecret: { apiKey: 'new-key' },
    });

    expect(updated.name).toBe('new name');
    expect(updated.status).toBe('inactive');
    const stored = await getRelayInternal(handle.db, relay.id);
    expect(decryptRelaySecret(keyring, stored!)).toEqual({ apiKey: 'new-key' });
  });

  it('merges a partial configSecret update instead of overwriting the whole blob (regression)', async () => {
    // A relay can hold several independent secret fields at once (e.g. webhook_sms's Twilio
    // config: accountSid + authToken). The web UI's SecretInput is write-only and can only ever
    // supply the one field the user actually replaced, since it never sees the others' current
    // values — so a bare `set.configSecret = encryptSecret(...)` on just that field would silently
    // delete every other stored secret. This is exactly that scenario, isolated from the telegram
    // auto-provisioning path exercised elsewhere.
    const user = await createUser(handle.db);
    const relay = await createRelay(handle.db, keyring, {
      userId: user.id,
      name: 'x',
      type: 'webhook_sms',
      configPublic: { provider: 'twilio' },
      configSecret: { accountSid: 'AC_TEST', authToken: 'old-token' },
    });

    await updateRelay(handle.db, keyring, user.id, relay.id, {
      configSecret: { authToken: 'new-token' },
    });

    const stored = await getRelayInternal(handle.db, relay.id);
    expect(decryptRelaySecret(keyring, stored!)).toEqual({
      accountSid: 'AC_TEST',
      authToken: 'new-token',
    });
  });

  it('leaves configSecret untouched when not provided in the update', async () => {
    const user = await createUser(handle.db);
    const relay = await createRelay(handle.db, keyring, {
      userId: user.id,
      name: 'x',
      type: 'webhook_sms',
      configSecret: { apiKey: 'stays' },
    });

    await updateRelay(handle.db, keyring, user.id, relay.id, { name: 'renamed' });

    const stored = await getRelayInternal(handle.db, relay.id);
    expect(decryptRelaySecret(keyring, stored!)).toEqual({ apiKey: 'stays' });
  });

  it('refuses to update a relay owned by someone else', async () => {
    const alice = await createUser(handle.db);
    const bob = await createUser(handle.db);
    const relay = await createRelay(handle.db, keyring, {
      userId: alice.id,
      name: 'x',
      type: 'chat_relay',
    });

    await expect(
      updateRelay(handle.db, keyring, bob.id, relay.id, { name: 'hijacked' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await getRelayForUser(handle.db, alice.id, relay.id))?.name).toBe('x');
  });
});

describe('rotateIngestToken', () => {
  it('replaces the token and the old one stops resolving', async () => {
    const user = await createUser(handle.db);
    const relay = await createRelay(handle.db, keyring, {
      userId: user.id,
      name: 'x',
      type: 'webhook_sms',
    });
    const oldToken = relay.ingestToken;

    const rotated = await rotateIngestToken(handle.db, user.id, relay.id);

    expect(rotated.ingestToken).not.toBe(oldToken);
    expect(await findRelayByIngestToken(handle.db, oldToken)).toBeUndefined();
    expect(await findRelayByIngestToken(handle.db, rotated.ingestToken)).toMatchObject({
      id: relay.id,
    });
  });

  it('refuses to rotate a relay owned by someone else', async () => {
    const alice = await createUser(handle.db);
    const bob = await createUser(handle.db);
    const relay = await createRelay(handle.db, keyring, {
      userId: alice.id,
      name: 'x',
      type: 'chat_relay',
    });

    await expect(rotateIngestToken(handle.db, bob.id, relay.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('deleteRelay', () => {
  it("deletes only the owner's relay", async () => {
    const alice = await createUser(handle.db);
    const bob = await createUser(handle.db);
    const relay = await createRelay(handle.db, keyring, {
      userId: alice.id,
      name: 'x',
      type: 'chat_relay',
    });

    await expect(deleteRelay(handle.db, bob.id, relay.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await deleteRelay(handle.db, alice.id, relay.id);
    expect(await getRelayInternal(handle.db, relay.id)).toBeUndefined();
  });

  it('reports NOT_FOUND for an unknown id', async () => {
    const user = await createUser(handle.db);
    await expect(
      deleteRelay(handle.db, user.id, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toBeInstanceOf(RelayError);
  });
});

describe('findRelayByIngestToken / touchLastTriggered', () => {
  it('resolves an active relay by its ingest token', async () => {
    const user = await createUser(handle.db);
    const relay = await createRelay(handle.db, keyring, {
      userId: user.id,
      name: 'x',
      type: 'webhook_sms',
    });

    const found = await findRelayByIngestToken(handle.db, relay.ingestToken);
    expect(found?.id).toBe(relay.id);
    expect(found?.status).toBe('active');
  });

  it('returns undefined for an unknown token', async () => {
    expect(await findRelayByIngestToken(handle.db, generateIngestToken())).toBeUndefined();
  });

  it('sets lastTriggeredAt', async () => {
    const user = await createUser(handle.db);
    const relay = await createRelay(handle.db, keyring, {
      userId: user.id,
      name: 'x',
      type: 'webhook_sms',
    });
    expect((await getRelayInternal(handle.db, relay.id))?.lastTriggeredAt).toBeNull();

    await touchLastTriggered(handle.db, relay.id);

    expect((await getRelayInternal(handle.db, relay.id))?.lastTriggeredAt).toBeInstanceOf(Date);
  });
});
