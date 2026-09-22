import { describe, expect, it } from 'vitest';
import { generateToken, hashToken, tokensMatch } from './token';

describe('generateToken', () => {
  it('generates url-safe tokens of the expected length and with no collisions', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateToken()));
    expect(tokens.size).toBe(200);
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(token.length).toBeGreaterThanOrEqual(40);
    }
  });

  it('respects a custom byte length', () => {
    expect(generateToken(16).length).toBeLessThan(generateToken(32).length);
  });
});

describe('hashToken / tokensMatch', () => {
  it('hashes deterministically to a 64-char hex sha-256', () => {
    const token = generateToken();
    const hash = hashToken(token);
    expect(hash).toBe(hashToken(token));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches equal hashes and rejects different ones', () => {
    const a = hashToken('token-a');
    const b = hashToken('token-b');
    expect(tokensMatch(a, a)).toBe(true);
    expect(tokensMatch(a, b)).toBe(false);
  });

  it('does not throw on malformed input and simply reports no match', () => {
    expect(tokensMatch('not-hex', hashToken('x'))).toBe(false);
    expect(tokensMatch('', '')).toBe(true);
  });
});
