/**
 * AES-256-GCM encryption utilities for sensitive data at rest.
 * Requires ENCRYPTION_KEY env var (min 32 chars).
 *
 * Key derivation: PBKDF2-SHA256 (100 000 iterations) is used for all new
 * encryptions. The legacy raw-slice key is kept as a fallback in `decrypt`
 * so that data encrypted before this change can still be read.
 *
 * MIGRATION NOTE: Existing encrypted values use the legacy raw key.
 * Re-encrypt them with the new derived key when convenient by reading and
 * re-saving each sensitive field (e.g. OAuth tokens in bank_accounts).
 */

import crypto, { pbkdf2Sync } from 'crypto';
import { log } from '@/lib/logger';

const ALGORITHM = 'aes-256-gcm';
const KDF_SALT = 'isaflow-encryption-salt';
const KDF_ITERATIONS = 100_000;

function getRawSecret(): string {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length < 32) {
    throw new Error('ENCRYPTION_KEY must be set (min 32 chars)');
  }
  return key;
}

/** Derive a 256-bit key using PBKDF2-SHA256 (current standard). */
function deriveKey(secret: string): Buffer {
  return pbkdf2Sync(secret, KDF_SALT, KDF_ITERATIONS, 32, 'sha256');
}

/** Legacy raw key used before PBKDF2 was introduced — decrypt fallback only. */
function getLegacyKey(secret: string): Buffer {
  return Buffer.from(secret.slice(0, 32), 'utf-8');
}

function getEncryptionKey(): Buffer {
  return deriveKey(getRawSecret());
}

export function isEncryptionAvailable(): boolean {
  const key = process.env.ENCRYPTION_KEY;
  return !!(key && key.length >= 32);
}

export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

function decryptWithKey(ciphertext: string, key: Buffer): string {
  const [ivHex, tagHex, encryptedHex] = ciphertext.split(':');
  if (!ivHex || !tagHex || !encryptedHex) {
    throw new Error('Invalid encrypted format');
  }
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export function decrypt(ciphertext: string): string {
  const secret = getRawSecret();
  // Try the current PBKDF2-derived key first.
  try {
    return decryptWithKey(ciphertext, deriveKey(secret));
  } catch {
    // Fall back to the legacy raw-slice key for data encrypted before the
    // PBKDF2 migration. Log a warning so operators know to re-encrypt.
    log.warn('Derived-key decrypt failed — retrying with legacy raw key', {}, 'encryption');
    return decryptWithKey(ciphertext, getLegacyKey(secret));
  }
}

/** Encrypt token if key is available, otherwise warn and return plaintext. */
export function encryptToken(plaintext: string): string {
  if (!isEncryptionAvailable()) {
    log.warn('ENCRYPTION_KEY not set — storing token as plaintext', {}, 'encryption');
    return plaintext;
  }
  return encrypt(plaintext);
}

/** Decrypt token if it looks encrypted, otherwise return as-is (plaintext fallback). */
export function decryptToken(value: string): string {
  if (!value) return value;
  // Encrypted format: hex:hex:hex (iv:tag:ciphertext)
  const parts = value.split(':');
  if (parts.length !== 3) {
    // Stored as plaintext — likely pre-encryption-key migration
    return value;
  }
  try {
    return decrypt(value);
  } catch {
    log.warn('Failed to decrypt token — returning as-is', {}, 'encryption');
    return value;
  }
}
