import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeHmac, HMAC_PRESETS, verifyHmac } from './hmac';

const secret = 'whsec_test_secret';
const body = '{"id":1042,"billing":{"phone":"0722123456"}}';

const sign = (
  data: Buffer | string,
  key = secret,
  algorithm = 'sha256',
  encoding: 'hex' | 'base64' = 'base64',
) => createHmac(algorithm, key).update(data).digest(encoding);

describe('verifyHmac', () => {
  it('accepts a correct base64 SHA-256 signature (WooCommerce / Shopify style)', () => {
    expect(
      verifyHmac({
        rawBody: body,
        secret,
        signature: sign(body),
        algorithm: 'sha256',
        encoding: 'base64',
      }),
    ).toBe(true);
  });

  it('accepts a correct hex signature and ignores hex case', () => {
    const hex = sign(body, secret, 'sha256', 'hex');
    for (const signature of [hex, hex.toUpperCase()]) {
      expect(
        verifyHmac({ rawBody: body, secret, signature, algorithm: 'sha256', encoding: 'hex' }),
      ).toBe(true);
    }
  });

  it.each(['sha1', 'sha256', 'sha512'] as const)('supports %s', (algorithm) => {
    expect(
      verifyHmac({
        rawBody: body,
        secret,
        signature: sign(body, secret, algorithm, 'hex'),
        algorithm,
        encoding: 'hex',
      }),
    ).toBe(true);
  });

  it('works on raw bytes, including non-UTF-8 and multi-byte content', () => {
    const raw = Buffer.from([0xff, 0xfe, 0x00, 0x7b, 0x7d, 0xc8, 0x99]);
    expect(
      verifyHmac({
        rawBody: raw,
        secret,
        signature: sign(raw),
        algorithm: 'sha256',
        encoding: 'base64',
      }),
    ).toBe(true);
    const unicode = '{"n":"Kovács Ilona ș ț 👋"}';
    expect(
      verifyHmac({
        rawBody: Buffer.from(unicode, 'utf8'),
        secret,
        signature: sign(unicode),
        algorithm: 'sha256',
        encoding: 'base64',
      }),
    ).toBe(true);
  });

  it('tolerates whitespace around the signature header value', () => {
    expect(
      verifyHmac({
        rawBody: body,
        secret,
        signature: `  ${sign(body)}\n`,
        algorithm: 'sha256',
        encoding: 'base64',
      }),
    ).toBe(true);
  });

  describe('rejections', () => {
    const base = { rawBody: body, secret, algorithm: 'sha256', encoding: 'base64' } as const;

    it('rejects a body changed by a single byte', () => {
      expect(verifyHmac({ ...base, rawBody: `${body} `, signature: sign(body) })).toBe(false);
      expect(
        verifyHmac({ ...base, rawBody: body.replace('1042', '1043'), signature: sign(body) }),
      ).toBe(false);
    });

    it('rejects a re-serialized (pretty-printed) body: only the raw bytes are signed', () => {
      const pretty = JSON.stringify(JSON.parse(body), null, 2);
      expect(verifyHmac({ ...base, rawBody: pretty, signature: sign(body) })).toBe(false);
    });

    it('rejects a wrong secret', () => {
      expect(verifyHmac({ ...base, signature: sign(body, 'another-secret') })).toBe(false);
    });

    it('rejects a wrong algorithm or encoding', () => {
      expect(verifyHmac({ ...base, signature: sign(body, secret, 'sha1') })).toBe(false);
      expect(verifyHmac({ ...base, signature: sign(body, secret, 'sha256', 'hex') })).toBe(false);
    });

    it('rejects a missing, empty, truncated, or extended signature', () => {
      const good = sign(body);
      expect(verifyHmac({ ...base, signature: undefined })).toBe(false);
      expect(verifyHmac({ ...base, signature: '' })).toBe(false);
      expect(verifyHmac({ ...base, signature: good.slice(0, -1) })).toBe(false);
      expect(verifyHmac({ ...base, signature: `${good}A` })).toBe(false);
    });

    it('rejects everything when the secret is empty, even a signature made with an empty key', () => {
      const emptyKeySignature = sign(body, '');
      expect(verifyHmac({ ...base, secret: '', signature: emptyKeySignature })).toBe(false);
    });

    it('does not treat base64 case as insignificant', () => {
      const good = sign(body);
      const swapped = good.replace(/[a-z]/i, (c) =>
        c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase(),
      );
      expect(swapped).not.toBe(good);
      expect(verifyHmac({ ...base, signature: swapped })).toBe(false);
    });
  });
});

describe('presets', () => {
  it('defines the WooCommerce preset from the plan', () => {
    expect(HMAC_PRESETS.woocommerce).toEqual({
      header: 'x-wc-webhook-signature',
      algorithm: 'sha256',
      encoding: 'base64',
    });
  });

  it('defines the Shopify preset from the plan', () => {
    expect(HMAC_PRESETS.shopify).toEqual({
      header: 'x-shopify-hmac-sha256',
      algorithm: 'sha256',
      encoding: 'base64',
    });
  });

  it.each(Object.entries(HMAC_PRESETS))(
    '%s: a signature made per the preset verifies',
    (_name, preset) => {
      const signature = computeHmac(body, secret, preset.algorithm, preset.encoding);
      expect(signature).toBe(sign(body, secret, preset.algorithm, preset.encoding));
      expect(
        verifyHmac({
          rawBody: body,
          secret,
          signature,
          algorithm: preset.algorithm,
          encoding: preset.encoding,
        }),
      ).toBe(true);
    },
  );
});
