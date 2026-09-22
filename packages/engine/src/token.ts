import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';

/**
 * Bearer secrets (session tokens, ingest tokens, reset/verification tokens): a random token is
 * given to the holder, but only its SHA-256 hash is stored, so a database read never discloses a
 * usable secret. `byteLength` of 32 gives 256 bits of entropy for a session/reset token.
 */
export function generateToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison of two token hashes (both are hex SHA-256, so always equal length). */
export function tokensMatch(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'hex');
  const bufferB = Buffer.from(b, 'hex');
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}
