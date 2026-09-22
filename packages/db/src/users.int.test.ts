import { hashToken } from '@smartrelay/engine';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, resetDb } from '../test/helpers';
import { AuthError } from './users';
import {
  consumeEmailVerifyToken,
  consumePasswordResetToken,
  createUser,
  findUserByEmail,
  findUserById,
  setEmailVerifyToken,
  setPasswordResetToken,
} from './users';
import type { DbHandle } from './client';

let handle: DbHandle;

beforeAll(() => {
  handle = createTestDb();
});
afterAll(async () => {
  await handle.close();
});
beforeEach(async () => {
  await resetDb(handle.db);
});

describe('createUser / lookups', () => {
  it('creates a user and finds it by email (case-insensitively) and id', async () => {
    const user = await createUser(handle.db, { email: 'Ana@Example.com', passwordHash: 'h' });

    expect(await findUserByEmail(handle.db, 'ana@EXAMPLE.com')).toMatchObject({ id: user.id });
    expect(await findUserById(handle.db, user.id)).toMatchObject({ email: 'Ana@Example.com' });
    expect(await findUserByEmail(handle.db, 'nope@example.com')).toBeUndefined();
  });

  it('rejects a duplicate email with EMAIL_TAKEN', async () => {
    await createUser(handle.db, { email: 'dup@example.com', passwordHash: 'h' });
    await expect(
      createUser(handle.db, { email: 'DUP@example.com', passwordHash: 'h2' }),
    ).rejects.toMatchObject({ code: 'EMAIL_TAKEN' });
  });
});

describe('email verification tokens', () => {
  it('verifies the email for a valid, unexpired token and consumes it', async () => {
    const user = await createUser(handle.db, { email: 'verify@example.com', passwordHash: 'h' });
    const hash = hashToken('raw-verify-token');
    await setEmailVerifyToken(handle.db, user.id, hash);

    const verified = await consumeEmailVerifyToken(handle.db, hash);

    expect(verified.id).toBe(user.id);
    expect(verified.emailVerifiedAt).toBeInstanceOf(Date);
    expect(verified.emailVerifyTokenHash).toBeNull();

    await expect(consumeEmailVerifyToken(handle.db, hash)).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
  });

  it('rejects an unknown or expired token', async () => {
    const user = await createUser(handle.db, { email: 'expired@example.com', passwordHash: 'h' });
    await expect(
      consumeEmailVerifyToken(handle.db, hashToken('never-issued')),
    ).rejects.toBeInstanceOf(AuthError);

    const hash = hashToken('expiring-token');
    await setEmailVerifyToken(handle.db, user.id, hash);
    await handle.db.execute(
      sql`UPDATE users SET email_verify_expires_at = now() - interval '1 hour' WHERE id = ${user.id}`,
    );
    await expect(consumeEmailVerifyToken(handle.db, hash)).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
  });

  it('issuing a new token invalidates the previous one', async () => {
    const user = await createUser(handle.db, { email: 'reissue@example.com', passwordHash: 'h' });
    const first = hashToken('first-token');
    const second = hashToken('second-token');
    await setEmailVerifyToken(handle.db, user.id, first);
    await setEmailVerifyToken(handle.db, user.id, second);

    await expect(consumeEmailVerifyToken(handle.db, first)).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
    await expect(consumeEmailVerifyToken(handle.db, second)).resolves.toMatchObject({
      id: user.id,
    });
  });
});

describe('password reset tokens', () => {
  it('resets the password for a valid token and consumes it', async () => {
    const user = await createUser(handle.db, { email: 'reset@example.com', passwordHash: 'old' });
    const hash = hashToken('raw-reset-token');
    await setPasswordResetToken(handle.db, user.id, hash);

    const updated = await consumePasswordResetToken(handle.db, hash, 'new-hash');

    expect(updated.id).toBe(user.id);
    expect(updated.passwordHash).toBe('new-hash');
    expect(updated.passwordResetTokenHash).toBeNull();

    await expect(consumePasswordResetToken(handle.db, hash, 'again')).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
    });
  });

  it('does not touch other users', async () => {
    const a = await createUser(handle.db, { email: 'a@example.com', passwordHash: 'ha' });
    const b = await createUser(handle.db, { email: 'b@example.com', passwordHash: 'hb' });
    const hash = hashToken('a-only-token');
    await setPasswordResetToken(handle.db, a.id, hash);

    await consumePasswordResetToken(handle.db, hash, 'new-a-hash');

    expect((await findUserById(handle.db, b.id))?.passwordHash).toBe('hb');
  });
});
