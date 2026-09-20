import { MICRO_PER_EUR } from './constants';

const CENTS_TO_MICRO = 10_000n;
const EUR_DECIMAL = /^(-)?(\d+)(?:\.(\d{1,6}))?$/;

/** Converts whole euro cents (e.g. a Stripe amount) to micro-euros. */
export function centsToMicro(cents: number | bigint): bigint {
  if (typeof cents === 'number' && !Number.isSafeInteger(cents)) {
    throw new RangeError('cents must be a safe integer');
  }
  return BigInt(cents) * CENTS_TO_MICRO;
}

/**
 * Parses a decimal euro string such as "12.50", "0.025" or "-3" into micro-euros without ever
 * going through a float. At most 6 decimals are accepted, because that is the storage precision.
 */
export function parseEurToMicro(input: string): bigint {
  const match = EUR_DECIMAL.exec(input.trim());
  if (!match) throw new RangeError('invalid euro amount');

  const [, sign, whole = '0', fraction = ''] = match;
  const micro = BigInt(whole) * MICRO_PER_EUR + BigInt(fraction.padEnd(6, '0'));
  return sign ? -micro : micro;
}

/**
 * Formats micro-euros as a decimal string with at least 2 and at most 6 decimals, dropping
 * trailing zeros beyond the second: 12_500_000n -> "12.50", 5_000n -> "0.005".
 */
export function formatMicroEur(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const whole = abs / MICRO_PER_EUR;
  const fraction = (abs % MICRO_PER_EUR).toString().padStart(6, '0');

  let trimmed = fraction.replace(/0+$/, '');
  if (trimmed.length < 2) trimmed = trimmed.padEnd(2, '0');

  return `${negative ? '-' : ''}${whole}.${trimmed}`;
}
