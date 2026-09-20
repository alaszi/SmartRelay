import { describe, expect, it } from 'vitest';
import { truncateUtf8 } from './text';

describe('truncateUtf8', () => {
  it('returns short text unchanged', () => {
    expect(truncateUtf8('hello', 10)).toBe('hello');
    expect(truncateUtf8('', 10)).toBe('');
    expect(truncateUtf8('hello', 5)).toBe('hello');
  });

  it('cuts ASCII text at the byte limit', () => {
    expect(truncateUtf8('abcdefgh', 5)).toBe('abcde');
  });

  it('never splits a multi-byte character', () => {
    // "ș" is 2 bytes, "€" is 3 bytes, "😀" is 4 bytes.
    expect(truncateUtf8('aș', 2)).toBe('a');
    expect(truncateUtf8('aș', 3)).toBe('aș');
    expect(truncateUtf8('a€', 3)).toBe('a');
    expect(truncateUtf8('a€', 4)).toBe('a€');
    expect(truncateUtf8('a😀', 4)).toBe('a');
    expect(truncateUtf8('a😀', 5)).toBe('a😀');
  });

  it('always fits the limit and never produces replacement characters', () => {
    const text = 'ș€😀a'.repeat(50);
    for (let limit = 0; limit <= 60; limit++) {
      const result = truncateUtf8(text, limit);
      expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(limit);
      expect(result).not.toContain('�');
      expect(text.startsWith(result)).toBe(true);
    }
  });

  it('returns an empty string for a zero limit', () => {
    expect(truncateUtf8('abc', 0)).toBe('');
  });

  it('produces text that fits the 8 KB response_excerpt column', () => {
    const excerpt = truncateUtf8('ș'.repeat(10_000), 8 * 1024);
    expect(Buffer.byteLength(excerpt, 'utf8')).toBeLessThanOrEqual(8192);
  });
});
