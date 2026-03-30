/**
 * AES-256-GCM encryption utilities for sensitive data at rest.
 * Requires ENCRYPTION_KEY env var (min 32 chars).
 */

import crypto from 'crypto';
import { log } from '@/lib/logger';

const ALGORITHM = 'aes-256-gcm';

function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length < 32) {
    throw new Error('ENCRYPTION_KEY must be set (min 32 chars)');
  }
  return Buffer.from(key.slice(0, 32), 'utf-8');
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

export function decrypt(ciphertext: string): string {
  const key = getEncryptionKey();
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
