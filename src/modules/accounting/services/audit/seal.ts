/**
 * The seal on an audit snapshot or check run: HMAC-SHA256 with a server key
 * the database never sees, over the domain and the fields that say what was
 * frozen — company | id | canonical hash | cutoff | taken_at. A row forged by
 * SQL cannot carry a seal that verifies without the key.
 *
 * Key: AUDIT_SNAPSHOT_SIGNING_KEY (≥ 32 characters) + AUDIT_SNAPSHOT_KEY_ID.
 * Only the current key is held; a seal made under another key id is reported
 * as `unknown_key`, never as valid or invalid.
 */
import { createHmac, timingSafeEqual } from 'crypto';

export const SNAPSHOT_SEAL_DOMAIN = 'isaflow:audit-snapshot:v1';
export const CHECK_RUN_SEAL_DOMAIN = 'isaflow:audit-check-run:v1';
export const PACK_SEAL_DOMAIN = 'isaflow:audit-pack:v1';
const MIN_KEY_LENGTH = 32;

export class SigningKeyMissingError extends Error {
  constructor() {
    super('Audit snapshots are not available: the signing key (AUDIT_SNAPSHOT_SIGNING_KEY, AUDIT_SNAPSHOT_KEY_ID) is not configured.');
    this.name = 'SigningKeyMissingError';
  }
}

export interface SigningKey { key: Buffer; keyId: string }

export function signingKey(): SigningKey {
  const raw = process.env.AUDIT_SNAPSHOT_SIGNING_KEY ?? '';
  const keyId = (process.env.AUDIT_SNAPSHOT_KEY_ID ?? '').trim();
  if (raw.length < MIN_KEY_LENGTH || keyId === '') throw new SigningKeyMissingError();
  return { key: Buffer.from(raw, 'utf8'), keyId };
}

export interface SealFields { companyId: string; id: string; canonicalHash: string; cutoff: string; takenAt: string }

export function sealMessage(domain: string, f: SealFields): string {
  return [domain, f.companyId, f.id, f.canonicalHash, f.cutoff, f.takenAt].join('|');
}

export function sign(domain: string, f: SealFields, k: SigningKey = signingKey()): { hmac: string; keyId: string } {
  return { hmac: createHmac('sha256', k.key).update(sealMessage(domain, f)).digest('hex'), keyId: k.keyId };
}

export type SealCheck = 'valid' | 'invalid' | 'unknown_key';

/** Timing-safe: the comparison does not stop at the first differing byte. */
export function checkSeal(domain: string, f: SealFields, hmac: string, keyId: string, k: SigningKey = signingKey()): SealCheck {
  if (keyId !== k.keyId) return 'unknown_key';
  const expected = Buffer.from(sign(domain, f, k).hmac, 'hex');
  const given = Buffer.from(/^[0-9a-f]{64}$/.test(hmac) ? hmac : '', 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected) ? 'valid' : 'invalid';
}
