import { describe, expect, it } from 'vitest';
import { DEFAULT_PRICES_MICRO } from './constants';
import { centsToMicro, formatMicroEur, parseEurToMicro } from './money';

describe('centsToMicro', () => {
  it('converts euro cents to micro-euros', () => {
    expect(centsToMicro(500)).toBe(5_000_000n);
    expect(centsToMicro(1)).toBe(10_000n);
    expect(centsToMicro(0)).toBe(0n);
    expect(centsToMicro(10_000n)).toBe(100_000_000n);
  });

  it('rejects non-integer and unsafe numbers', () => {
    expect(() => centsToMicro(1.5)).toThrow(RangeError);
    expect(() => centsToMicro(Number.NaN)).toThrow(RangeError);
    expect(() => centsToMicro(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
  });
});

describe('parseEurToMicro', () => {
  it.each([
    ['5', 5_000_000n],
    ['5.00', 5_000_000n],
    ['12.5', 12_500_000n],
    ['0.025', 25_000n],
    ['0.005', 5_000n],
    ['0.000001', 1n],
    ['-3', -3_000_000n],
    ['-0.01', -10_000n],
    ['  7.10 ', 7_100_000n],
  ])('parses %s', (input, expected) => {
    expect(parseEurToMicro(input)).toBe(expected);
  });

  it('is exact where floating point is not (0.1 + 0.2 style inputs)', () => {
    expect(parseEurToMicro('0.1') + parseEurToMicro('0.2')).toBe(parseEurToMicro('0.3'));
  });

  it.each(['', '.', '1.', '.5', '1.2345678', 'abc', '1e3', '1,5', '--1', '+1', '1 2'])(
    'rejects %j',
    (input) => {
      expect(() => parseEurToMicro(input)).toThrow(RangeError);
    },
  );
});

describe('formatMicroEur', () => {
  it.each([
    [0n, '0.00'],
    [5_000n, '0.005'],
    [25_000n, '0.025'],
    [1n, '0.000001'],
    [12_500_000n, '12.50'],
    [5_000_000n, '5.00'],
    [-5_000n, '-0.005'],
    [-12_500_000n, '-12.50'],
    [123_456_789_000_000n, '123456789.00'],
  ])('formats %s as %s', (micro, expected) => {
    expect(formatMicroEur(micro)).toBe(expected);
  });

  it('round-trips through parseEurToMicro', () => {
    for (const micro of [0n, 1n, 5_000n, 25_000n, 999_999n, 1_000_000n, 12_345_678n, -7_777n]) {
      expect(parseEurToMicro(formatMicroEur(micro))).toBe(micro);
    }
  });
});

describe('DEFAULT_PRICES_MICRO', () => {
  it('matches the plan (EUR 0.005 / 0.01 / 0.025)', () => {
    expect(formatMicroEur(DEFAULT_PRICES_MICRO.relay_http)).toBe('0.005');
    expect(formatMicroEur(DEFAULT_PRICES_MICRO.calendar_event)).toBe('0.01');
    expect(formatMicroEur(DEFAULT_PRICES_MICRO.sms_dispatch)).toBe('0.025');
  });
});
