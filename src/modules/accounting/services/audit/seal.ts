/**
 * The seal on an audit snapshot or check run: HMAC-SHA256 with a server key
 * the database never sees, over the domain and the fields that say what was
 * frozen — company | id | canonical hash | cutoff | taken_at. A row forged by
 * SQL cannot carry a seal that verifies without the key.
 *
 * Key: AUDIT_SNAPSHOT_SIGNING_KEY (≥ 32 characters) + AUDIT_SNAPSHOT_KEY_ID.
 * Rotation keeps the old keys for verification: AUDIT_SNAPSHOT_RETIRED_KEYS is
 * `id=secret,id=secret` (each secret ≥ 32 characters, no commas). A seal under the
 * current or a retired key verifies against that key; under any other key id it
 * is `invalid` — the key id is the writer's input, so one the server holds no key
 * for proves nothing and must not read as "cannot tell".
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

export interface SigningKey { key: Buffer; keyId: string; retired?: ReadonlyMap<string, Buffer> }

export function signingKey(): SigningKey {
  const raw = process.env.AUDIT_SNAPSHOT_SIGNING_KEY ?? '';
  const keyId = (process.env.AUDIT_SNAPSHOT_KEY_ID ?? '').trim();
  if (raw.length < MIN_KEY_LENGTH || keyId === '') throw new SigningKeyMissingError();
  const retired = new Map<string, Buffer>();
  for (const entry of (process.env.AUDIT_SNAPSHOT_RETIRED_KEYS ?? '').split(',')) {
    const at = entry.indexOf('=');
    const id = entry.slice(0, at).trim();
    const secret = entry.slice(at + 1);
    // A malformed entry is left out: its seals then read invalid (fail closed), never valid.
    if (at > 0 && id !== keyId && secret.length >= MIN_KEY_LENGTH) retired.set(id, Buffer.from(secret, 'utf8'));
  }
  return { key: Buffer.from(raw, 'utf8'), keyId, retired };
}

export interface SealFields {
  companyId: string; id: string; canonicalHash: string; cutoff: string; takenAt: string;
  /** A snapshot's place in its company's chain: signed, so a removed or replaced link breaks the chain. */
  chain?: { seq: number; prevHmac: string | null };
}

export function sealMessage(domain: string, f: SealFields): string {
  const parts = [domain, f.companyId, f.id, f.canonicalHash, f.cutoff, f.takenAt];
  if (f.chain) parts.push(String(f.chain.seq), f.chain.prevHmac ?? '-');
  return parts.join('|');
}

const hmacHex = (key: Buffer, message: string) => createHmac('sha256', key).update(message).digest('hex');

export function sign(domain: string, f: SealFields, k: SigningKey = signingKey()): { hmac: string; keyId: string } {
  return { hmac: hmacHex(k.key, sealMessage(domain, f)), keyId: k.keyId };
}

export type SealCheck = 'valid' | 'invalid';

/** Timing-safe: the comparison does not stop at the first differing byte. */
export function checkSeal(domain: string, f: SealFields, hmac: string, keyId: string, k: SigningKey = signingKey()): SealCheck {
  const key = keyId === k.keyId ? k.key : k.retired?.get(keyId);
  if (!key) return 'invalid';
  const expected = Buffer.from(hmacHex(key, sealMessage(domain, f)), 'hex');
  const given = Buffer.from(/^[0-9a-f]{64}$/.test(hmac) ? hmac : '', 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected) ? 'valid' : 'invalid';
}
