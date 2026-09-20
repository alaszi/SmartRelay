import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ENCRYPTION_KEY_ID_PATTERN, parsePreviousEncryptionKeys } from '@smartrelay/shared';

export type CryptoErrorCode =
  'INVALID_KEY' | 'MALFORMED_BLOB' | 'UNKNOWN_KEY_ID' | 'DECRYPT_FAILED';

/** Messages never contain key material or plaintext. */
export class CryptoError extends Error {
  readonly code: CryptoErrorCode;

  constructor(code: CryptoErrorCode, message: string) {
    super(message);
    this.name = 'CryptoError';
    this.code = code;
  }
}

export interface KeyMaterial {
  id: string;
  /** 32 bytes: a Buffer, or base64 text. */
  key: Buffer | string;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

interface ParsedBlob {
  keyId: string;
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

function toKeyBuffer(material: KeyMaterial): Buffer {
  if (!ENCRYPTION_KEY_ID_PATTERN.test(material.id)) {
    throw new CryptoError('INVALID_KEY', 'key id must be 1-32 characters of A-Z a-z 0-9 _ -');
  }
  const key =
    typeof material.key === 'string'
      ? Buffer.from(material.key, 'base64')
      : Buffer.from(material.key);
  if (key.length !== KEY_BYTES) {
    throw new CryptoError('INVALID_KEY', `key "${material.id}" must be exactly 32 bytes`);
  }
  return key;
}

function parseBlob(blob: string): ParsedBlob {
  const parts = blob.split(':');
  if (parts.length !== 4) throw new CryptoError('MALFORMED_BLOB', 'malformed encrypted value');

  const [keyId = '', ivText = '', tagText = '', ciphertextText = ''] = parts;
  if (
    !ENCRYPTION_KEY_ID_PATTERN.test(keyId) ||
    !BASE64URL.test(ivText) ||
    !BASE64URL.test(tagText) ||
    !BASE64URL.test(ciphertextText)
  ) {
    throw new CryptoError('MALFORMED_BLOB', 'malformed encrypted value');
  }

  const iv = Buffer.from(ivText, 'base64url');
  const tag = Buffer.from(tagText, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new CryptoError('MALFORMED_BLOB', 'malformed encrypted value');
  }
  return { keyId, iv, tag, ciphertext: Buffer.from(ciphertextText, 'base64url') };
}

/**
 * AES-256-GCM with a key id in every stored value (`keyId:iv:tag:ciphertext`, base64url parts), so
 * keys can rotate: new writes use the current key, old values stay readable with previous keys
 * until `rotate` re-encrypts them. Optional `aad` binds a value to its context (e.g. the relay
 * id), so a blob copied to another row fails to decrypt.
 */
export class Keyring {
  // Real private fields: they do not show up in console.log, JSON.stringify or util.inspect.
  readonly #keys = new Map<string, Buffer>();
  readonly currentKeyId: string;

  constructor(current: KeyMaterial, previous: readonly KeyMaterial[] = []) {
    for (const material of [current, ...previous]) {
      if (this.#keys.has(material.id)) {
        throw new CryptoError('INVALID_KEY', `duplicate key id "${material.id}"`);
      }
      this.#keys.set(material.id, toKeyBuffer(material));
    }
    this.currentKeyId = current.id;
  }

  encrypt(plaintext: string, aad?: string): string {
    const key = this.#keys.get(this.currentKeyId);
    if (!key) throw new CryptoError('UNKNOWN_KEY_ID', 'current key is not loaded');

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    if (aad !== undefined) cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

    return [
      this.currentKeyId,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join(':');
  }

  decrypt(blob: string, aad?: string): string {
    const parsed = parseBlob(blob);
    const key = this.#keys.get(parsed.keyId);
    if (!key) throw new CryptoError('UNKNOWN_KEY_ID', `no key loaded for id "${parsed.keyId}"`);

    try {
      const decipher = createDecipheriv('aes-256-gcm', key, parsed.iv, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAuthTag(parsed.tag);
      if (aad !== undefined) decipher.setAAD(Buffer.from(aad, 'utf8'));
      return Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]).toString('utf8');
    } catch {
      // Wrong key, wrong aad and tampering are deliberately indistinguishable.
      throw new CryptoError('DECRYPT_FAILED', 'could not decrypt value');
    }
  }

  /** True when the value was written with a key other than the current one. */
  needsRotation(blob: string): boolean {
    return parseBlob(blob).keyId !== this.currentKeyId;
  }

  /** Re-encrypts a value with the current key. */
  rotate(blob: string, aad?: string): string {
    return this.encrypt(this.decrypt(blob, aad), aad);
  }
}

/** Builds the keyring from the validated environment (see ENCRYPTION_KEY* in the env module). */
export function keyringFromEnv(env: {
  ENCRYPTION_KEY: string;
  ENCRYPTION_KEY_ID: string;
  ENCRYPTION_KEYS_PREVIOUS?: string | undefined;
}): Keyring {
  const previous =
    env.ENCRYPTION_KEYS_PREVIOUS === undefined
      ? []
      : (parsePreviousEncryptionKeys(env.ENCRYPTION_KEYS_PREVIOUS) ?? []);

  return new Keyring({ id: env.ENCRYPTION_KEY_ID, key: env.ENCRYPTION_KEY }, previous);
}
