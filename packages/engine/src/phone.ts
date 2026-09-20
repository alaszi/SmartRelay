import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';
import { ERROR_CODES } from '@smartrelay/shared';

export class PhoneError extends Error {
  readonly code = ERROR_CODES.INVALID_PHONE;

  constructor() {
    // Deliberately does not echo the input: phone numbers are personal data.
    super('Recipient is not a valid phone number');
    this.name = 'PhoneError';
  }
}

const MAX_INPUT_LENGTH = 64;

// libphonenumber extracts a number from surrounding prose ("call me on 0722..."), which is wrong
// for a billed SMS gateway, so only phone-like characters are accepted (any script's digits).
const PHONE_LIKE = /^(?:tel:)?[\s+\-.()/\p{Nd}]+$/u;

/**
 * Normalizes a phone number to E.164 (e.g. "0722 123 456" -> "+40722123456"). Numbers without a
 * country prefix are read in `defaultRegion` (Romania). Anything libphonenumber does not consider
 * valid for its region throws PhoneError, which is a terminal (non-retryable) failure.
 */
export function normalizePhone(input: unknown, defaultRegion: CountryCode = 'RO'): string {
  let text: string;
  if (typeof input === 'string') {
    text = input.trim();
  } else if (typeof input === 'number' && Number.isSafeInteger(input) && input > 0) {
    text = String(input);
  } else {
    throw new PhoneError();
  }

  if (text.length === 0 || text.length > MAX_INPUT_LENGTH || !PHONE_LIKE.test(text)) {
    throw new PhoneError();
  }

  const phone = parsePhoneNumberFromString(text, defaultRegion);
  if (!phone?.isValid()) throw new PhoneError();
  return phone.number;
}
