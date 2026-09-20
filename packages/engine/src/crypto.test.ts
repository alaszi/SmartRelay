import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { CryptoError, Keyring, keyringFromEnv } from './crypto';

const newKey = () => randomBytes(32);

function decryptError(keyring: Keyring, blob: string, aad?: string): CryptoError {
  try {
    keyring.decrypt(blob, aad);
  } catch (error) {
    if (error instanceof CryptoError) return error;
    throw error;
  }
  throw new Error('expected decrypt to throw');
}

describe('encrypt / decrypt round trip', () => {
  const keyring = new Keyring({ id: 'k1', key: newKey() });

  it.each([
    ['plain ascii', 'my-sms-provider-api-key'],
    ['json secrets', JSON.stringify({ apiKey: 'abc', apiSecret: 'def', sender: 'SmartRelay' })],
    ['unicode', 'Kovács Ilona ș ț ă î â 👋 密码'],
    ['empty string', ''],
    ['very long', 'x'.repeat(100_000)],
    ['characters used as separators', 'a:b:c::d\n\t\0'],
  ])('round-trips %s', (_label, plaintext) => {
    expect(keyring.decrypt(keyring.encrypt(plaintext))).toBe(plaintext);
  });

  it('produces different ciphertext each time (fresh random IV)', () => {
    const blobs = new Set(Array.from({ length: 50 }, () => keyring.encrypt('same plaintext')));
    expect(blobs.size).toBe(50);
  });

  it('stores values as keyId:iv:tag:ciphertext in base64url', () => {
    const blob = keyring.encrypt('hello');
    const parts = blob.split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('k1');
    expect(Buffer.from(parts[1] ?? '', 'base64url')).toHaveLength(12);
    expect(Buffer.from(parts[2] ?? '', 'base64url')).toHaveLength(16);
    expect(blob).toMatch(/^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]*$/);
  });

  it('does not contain the plaintext in the stored value', () => {
    const blob = keyring.encrypt('super-secret-provider-token');
    expect(blob).not.toContain('super-secret-provider-token');
    expect(Buffer.from(blob, 'utf8').toString('latin1')).not.toContain('super-secret');
  });
});

describe('integrity', () => {
  const keyring = new Keyring({ id: 'k1', key: newKey() });
  const blob = keyring.encrypt('the secret');

  function tamper(part: number, transform: (value: string) => string): string {
    const parts = blob.split(':');
    parts[part] = transform(parts[part] ?? '');
    return parts.join(':');
  }

  const flipFirst = (value: string) =>
    value.startsWith('A') ? `B${value.slice(1)}` : `A${value.slice(1)}`;

  it('rejects a modified ciphertext, tag or IV', () => {
    for (const part of [1, 2, 3]) {
      expect(decryptError(keyring, tamper(part, flipFirst)).code).toBe('DECRYPT_FAILED');
    }
  });

  it('rejects a truncated ciphertext', () => {
    expect(
      decryptError(
        keyring,
        tamper(3, (value) => value.slice(0, -2)),
      ).code,
    ).toBe('DECRYPT_FAILED');
  });

  it('rejects a tag of the wrong length instead of accepting a shortened tag', () => {
    expect(
      decryptError(
        keyring,
        tamper(2, (value) => value.slice(0, 8)),
      ).code,
    ).toBe('MALFORMED_BLOB');
  });

  it('rejects a value encrypted with another key', () => {
    const other = new Keyring({ id: 'k1', key: newKey() });
    expect(decryptError(other, blob).code).toBe('DECRYPT_FAILED');
  });

  it.each([
    '',
    'nonsense',
    'k1:only:three',
    'k1:a:b:c:d',
    ':::',
    'k1:!!!:###:$$$',
    'k 1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:AA',
  ])('reports MALFORMED_BLOB for %j', (bad) => {
    expect(decryptError(keyring, bad).code).toBe('MALFORMED_BLOB');
  });

  it('never leaks the plaintext or key material in error messages', () => {
    const material = newKey();
    const ring = new Keyring({ id: 'k1', key: material });
    const secretBlob = ring.encrypt('plaintext-that-must-not-leak');
    const errors = [
      decryptError(ring, tamper(3, flipFirst)),
      decryptError(ring, 'garbage'),
      decryptError(new Keyring({ id: 'k9', key: newKey() }), secretBlob),
    ];
    for (const error of errors) {
      expect(error.message).not.toContain('plaintext-that-must-not-leak');
      expect(error.message).not.toContain(material.toString('base64'));
      expect(error.message).not.toContain(material.toString('hex'));
    }
  });
});

describe('authenticated context (aad)', () => {
  const keyring = new Keyring({ id: 'k1', key: newKey() });

  it('decrypts only with the same context', () => {
    const blob = keyring.encrypt('token', 'relay:aaa');
    expect(keyring.decrypt(blob, 'relay:aaa')).toBe('token');
    expect(decryptError(keyring, blob, 'relay:bbb').code).toBe('DECRYPT_FAILED');
    expect(decryptError(keyring, blob).code).toBe('DECRYPT_FAILED');
  });

  it('a value encrypted without context does not decrypt with one', () => {
    const blob = keyring.encrypt('token');
    expect(decryptError(keyring, blob, 'relay:aaa').code).toBe('DECRYPT_FAILED');
  });
});

describe('key rotation', () => {
  const oldKey = newKey();
  const newerKey = newKey();

  it('keeps old values readable after the current key changes', () => {
    const before = new Keyring({ id: 'k1', key: oldKey });
    const blob = before.encrypt('provider-secret');

    const after = new Keyring({ id: 'k2', key: newerKey }, [{ id: 'k1', key: oldKey }]);
    expect(after.decrypt(blob)).toBe('provider-secret');
    expect(after.needsRotation(blob)).toBe(true);
  });

  it('encrypts new values with the current key only', () => {
    const ring = new Keyring({ id: 'k2', key: newerKey }, [{ id: 'k1', key: oldKey }]);
    const blob = ring.encrypt('fresh');
    expect(blob.startsWith('k2:')).toBe(true);
    expect(ring.needsRotation(blob)).toBe(false);
  });

  it('rotate() re-encrypts under the current key without changing the plaintext', () => {
    const blob = new Keyring({ id: 'k1', key: oldKey }).encrypt('provider-secret', 'relay:1');
    const ring = new Keyring({ id: 'k2', key: newerKey }, [{ id: 'k1', key: oldKey }]);

    const rotated = ring.rotate(blob, 'relay:1');

    expect(rotated.startsWith('k2:')).toBe(true);
    expect(rotated).not.toBe(blob);
    expect(ring.decrypt(rotated, 'relay:1')).toBe('provider-secret');
    expect(ring.needsRotation(rotated)).toBe(false);
  });

  it('a rotated value no longer needs the old key', () => {
    const blob = new Keyring({ id: 'k1', key: oldKey }).encrypt('provider-secret');
    const ring = new Keyring({ id: 'k2', key: newerKey }, [{ id: 'k1', key: oldKey }]);
    const rotated = ring.rotate(blob);

    const withoutOldKey = new Keyring({ id: 'k2', key: newerKey });
    expect(withoutOldKey.decrypt(rotated)).toBe('provider-secret');
  });

  it('reports UNKNOWN_KEY_ID when the old key was dropped too early', () => {
    const blob = new Keyring({ id: 'k1', key: oldKey }).encrypt('provider-secret');
    const ring = new Keyring({ id: 'k2', key: newerKey });

    expect(decryptError(ring, blob).code).toBe('UNKNOWN_KEY_ID');
    expect(ring.needsRotation(blob)).toBe(true);
  });

  it('rotates through several generations', () => {
    const k3 = newKey();
    const v1 = new Keyring({ id: 'k1', key: oldKey }).encrypt('s');
    const gen2 = new Keyring({ id: 'k2', key: newerKey }, [{ id: 'k1', key: oldKey }]);
    const v2 = gen2.rotate(v1);
    const gen3 = new Keyring({ id: 'k3', key: k3 }, [
      { id: 'k2', key: newerKey },
      { id: 'k1', key: oldKey },
    ]);

    expect(gen3.decrypt(v1)).toBe('s');
    expect(gen3.decrypt(v2)).toBe('s');
    expect(gen3.rotate(v1).startsWith('k3:')).toBe(true);
    expect(gen3.rotate(v2).startsWith('k3:')).toBe(true);
  });

  it('a wrongly labelled key id fails authentication rather than returning garbage', () => {
    const blob = new Keyring({ id: 'k1', key: oldKey }).encrypt('secret');
    const confused = new Keyring({ id: 'k2', key: newerKey }, [{ id: 'k1', key: newKey() }]);
    expect(decryptError(confused, blob).code).toBe('DECRYPT_FAILED');
  });
});

describe('key validation', () => {
  it('requires 32-byte keys', () => {
    expect(() => new Keyring({ id: 'k1', key: randomBytes(16) })).toThrow(CryptoError);
    expect(() => new Keyring({ id: 'k1', key: randomBytes(33) })).toThrow(CryptoError);
    expect(() => new Keyring({ id: 'k1', key: 'short' })).toThrow(CryptoError);
    expect(() => new Keyring({ id: 'k1', key: randomBytes(32).toString('base64') })).not.toThrow();
  });

  it('rejects key ids that could break the blob format', () => {
    for (const id of ['', 'a:b', 'has space', 'x'.repeat(33), 'é']) {
      expect(() => new Keyring({ id, key: newKey() })).toThrow(CryptoError);
    }
  });

  it('rejects duplicate key ids', () => {
    expect(() => new Keyring({ id: 'k1', key: newKey() }, [{ id: 'k1', key: newKey() }])).toThrow(
      /duplicate/,
    );
  });

  it('does not expose keys through inspection or serialization', () => {
    const material = newKey();
    const ring = new Keyring({ id: 'k1', key: material });
    const dumped = `${inspect(ring, { depth: 5, showHidden: true })} ${JSON.stringify(ring)}`;
    expect(dumped).not.toContain(material.toString('base64'));
    expect(dumped).not.toContain(material.toString('hex'));
  });
});

describe('keyringFromEnv', () => {
  it('builds a keyring from the environment values', () => {
    const current = newKey().toString('base64');
    const ring = keyringFromEnv({ ENCRYPTION_KEY: current, ENCRYPTION_KEY_ID: 'k7' });
    expect(ring.currentKeyId).toBe('k7');
    expect(ring.decrypt(ring.encrypt('x'))).toBe('x');
  });

  it('loads previous keys so old blobs stay readable', () => {
    const oldKey = newKey();
    const oldBlob = new Keyring({ id: 'k1', key: oldKey }).encrypt('legacy');

    const ring = keyringFromEnv({
      ENCRYPTION_KEY: newKey().toString('base64'),
      ENCRYPTION_KEY_ID: 'k2',
      ENCRYPTION_KEYS_PREVIOUS: `k1:${oldKey.toString('base64')}`,
    });

    expect(ring.decrypt(oldBlob)).toBe('legacy');
    expect(ring.needsRotation(oldBlob)).toBe(true);
  });
});
