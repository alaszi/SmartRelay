import { hash, verify } from '@node-rs/argon2';

// OWASP-recommended argon2id parameters (m=19MiB, t=2, p=1) as of 2024.
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

/** Never throws on a wrong password; only rejects on a malformed hash (e.g. DB corruption). */
export function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return verify(passwordHash, password);
}
