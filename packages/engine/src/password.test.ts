import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password';

describe('password hashing', () => {
  it('hashes and verifies a matching password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('wrong password', hash)).toBe(false);
  });

  it('produces argon2id hashes with a random salt each time', async () => {
    const a = await hashPassword('same password');
    const b = await hashPassword('same password');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^\$argon2id\$/);
  });

  it('does not store the plaintext password in the hash', async () => {
    const hash = await hashPassword('super-secret-plaintext');
    expect(hash).not.toContain('super-secret-plaintext');
  });

  it('is case-sensitive and exact', async () => {
    const hash = await hashPassword('Password1');
    expect(await verifyPassword('password1', hash)).toBe(false);
    expect(await verifyPassword('Password1 ', hash)).toBe(false);
  });

  it('handles unicode and empty passwords', async () => {
    const hash = await hashPassword('Jelszó ș ț 👋');
    expect(await verifyPassword('Jelszó ș ț 👋', hash)).toBe(true);
    const emptyHash = await hashPassword('');
    expect(await verifyPassword('', emptyHash)).toBe(true);
  });
});
