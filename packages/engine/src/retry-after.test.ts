import { describe, expect, it } from 'vitest';
import { parseRetryAfterMs } from './retry-after';

describe('parseRetryAfterMs', () => {
  it('parses a numeric seconds value', () => {
    expect(parseRetryAfterMs('120')).toBe(120_000);
    expect(parseRetryAfterMs('0')).toBe(0);
  });

  it('parses an HTTP-date in the future relative to `now`', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(parseRetryAfterMs('Thu, 01 Jan 2026 00:02:00 GMT', now)).toBe(120_000);
  });

  it('returns undefined for a date in the past', () => {
    const now = new Date('2026-01-01T00:02:00Z');
    expect(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:00 GMT', now)).toBeUndefined();
  });

  it('returns undefined for missing, empty, or unparsable values', () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
    expect(parseRetryAfterMs('   ')).toBeUndefined();
    expect(parseRetryAfterMs('not-a-value')).toBeUndefined();
  });

  it('does not treat a negative or non-integer numeric string as seconds', () => {
    expect(parseRetryAfterMs('-5')).toBeUndefined();
    expect(parseRetryAfterMs('5.5')).toBeUndefined();
  });
});
