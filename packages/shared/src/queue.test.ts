import { describe, expect, it } from 'vitest';
import { DELIVER_MAX_ATTEMPTS, deliverBackoffMs } from './queue';

describe('deliverBackoffMs', () => {
  it('returns 1 min, 5 min, 15 min for the three retries', () => {
    expect(deliverBackoffMs(1)).toBe(60_000);
    expect(deliverBackoffMs(2)).toBe(300_000);
    expect(deliverBackoffMs(3)).toBe(900_000);
  });

  it('returns undefined once retries are exhausted (attempts: 4 = initial + 3 retries)', () => {
    expect(deliverBackoffMs(4)).toBeUndefined();
    expect(DELIVER_MAX_ATTEMPTS).toBe(4);
  });
});
