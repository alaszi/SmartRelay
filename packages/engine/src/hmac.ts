import { createHmac, timingSafeEqual } from 'node:crypto';

export type HmacAlgorithm = 'sha1' | 'sha256' | 'sha512';
export type HmacEncoding = 'hex' | 'base64';

export interface HmacSpec {
  /** Lower-case name of the request header that carries the signature. */
  header: string;
  algorithm: HmacAlgorithm;
  encoding: HmacEncoding;
}

/** Presets from the plan (section 6, Module 1): HMAC of the raw body, keyed with the shared secret. */
export const HMAC_PRESETS = {
  woocommerce: { header: 'x-wc-webhook-signature', algorithm: 'sha256', encoding: 'base64' },
  shopify: { header: 'x-shopify-hmac-sha256', algorithm: 'sha256', encoding: 'base64' },
} as const satisfies Record<string, HmacSpec>;

export type HmacPresetName = keyof typeof HMAC_PRESETS;

export function computeHmac(
  rawBody: Buffer | string,
  secret: string,
  algorithm: HmacAlgorithm,
  encoding: HmacEncoding,
): string {
  return createHmac(algorithm, secret).update(rawBody).digest(encoding);
}

/**
 * Verifies a webhook signature over the RAW request body (never a re-serialized parse of it),
 * comparing in constant time. Returns false for any mismatch or malformed signature.
 */
export function verifyHmac(input: {
  rawBody: Buffer | string;
  secret: string;
  signature: string | undefined;
  algorithm: HmacAlgorithm;
  encoding: HmacEncoding;
}): boolean {
  if (input.secret.length === 0 || input.signature === undefined) return false;

  const normalize = (value: string) => (input.encoding === 'hex' ? value.toLowerCase() : value);
  const expected = Buffer.from(
    normalize(computeHmac(input.rawBody, input.secret, input.algorithm, input.encoding)),
    'utf8',
  );
  const provided = Buffer.from(normalize(input.signature.trim()), 'utf8');

  // timingSafeEqual requires equal lengths; the length of a valid signature is public anyway.
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}
