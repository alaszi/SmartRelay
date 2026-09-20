import { describe, expect, it } from 'vitest';
import { normalizePhone, PhoneError } from './phone';

describe('normalizePhone (default region RO)', () => {
  it.each([
    ['0722123456', '+40722123456'],
    ['0722 123 456', '+40722123456'],
    ['0722-123-456', '+40722123456'],
    ['(0722) 123-456', '+40722123456'],
    ['+40722123456', '+40722123456'],
    ['+40 722 123 456', '+40722123456'],
    ['+40 (0) 722 123 456', '+40722123456'],
    ['0040722123456', '+40722123456'],
    ['40722123456', '+40722123456'],
    ['722123456', '+40722123456'],
    ['  +40722123456 ', '+40722123456'],
    ['+40722123456\n', '+40722123456'],
    ['tel:+40722123456', '+40722123456'],
    ['0212345678', '+40212345678'],
  ])('normalizes %j to %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it('accepts numbers from other countries when given with a + prefix', () => {
    expect(normalizePhone('+36 30 123 4567')).toBe('+36301234567');
    expect(normalizePhone('+44 7911 123456')).toBe('+447911123456');
    expect(normalizePhone('+1 202 555 0123')).toBe('+12025550123');
  });

  it('accepts non-ASCII digits', () => {
    expect(normalizePhone('０７２２１２３４５６')).toBe('+40722123456');
  });

  it('accepts a positive integer, as some shop platforms send numbers', () => {
    expect(normalizePhone(40722123456)).toBe('+40722123456');
  });

  it('reads a local Hungarian number only with the HU region', () => {
    expect(() => normalizePhone('06301234567')).toThrow(PhoneError);
    expect(normalizePhone('06301234567', 'HU')).toBe('+36301234567');
  });
});

describe('normalizePhone: invalid input (INVALID_PHONE)', () => {
  it.each([
    '',
    '   ',
    'abc',
    '+',
    '00',
    '+4072212345',
    '+407221234567',
    '+40 722 123 45x',
    '07221234567890123456789012345',
    '12345',
    '0',
  ])('rejects %j', (input) => {
    expect(() => normalizePhone(input)).toThrow(PhoneError);
  });

  it.each([
    'not a number 0722123456 maybe',
    'call me on 0722123456',
    '0722123456 ext. 12',
    '0722123456 or 0733111222x',
    '0722123456;drop',
    '+40722123456<script>',
    'tel:tel:+40722123456',
  ])('does not extract a number out of surrounding text: %j', (input) => {
    expect(() => normalizePhone(input)).toThrow(PhoneError);
  });

  it.each([null, undefined, {}, [], true, 0, -5, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])(
    'rejects non-string value %j',
    (input) => {
      expect(() => normalizePhone(input)).toThrow(PhoneError);
    },
  );

  it('uses the INVALID_PHONE code and never echoes the number', () => {
    try {
      normalizePhone('+4072212345');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PhoneError);
      expect((error as PhoneError).code).toBe('INVALID_PHONE');
      expect((error as PhoneError).message).not.toContain('4072212345');
    }
  });
});
