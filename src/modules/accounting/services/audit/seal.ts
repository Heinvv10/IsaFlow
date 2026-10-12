/**
 * The seal on an audit snapshot or check run: HMAC-SHA256 with a server key
 * the database never sees, over the domain and the fields that say what was
 * frozen — company | id | canonical hash | cutoff | taken_at. A row forged by
 * SQL cannot carry a seal that verifies without the key.
 *
 * Key: AUDIT_SNAPSHOT_SIGNING_KEY (≥ 32 characters) + AUDIT_SNAPSHOT_KEY_ID.
 * Rotation keeps the old keys for verification: AUDIT_SNAPSHOT_RETIRED_KEYS is
 * `id=secret@retired-at,…` (each secret ≥ 32 characters, no commas; retired-at an
 * ISO instant, e.g. 2026-10-12T14:00:00Z). A seal under a retired key verifies only
 * when it was taken BEFORE that instant: rotating away from a leaked key stops
 * forgeries under it (taken_at is the writer's now(), not the caller's). Under any
 * other key id a seal is `invalid` — the key id is the writer's input, so one the
 * server holds no key for proves nothing and must not read as "cannot tell". A malformed retired entry refuses every
 * audit operation (503) until fixed.
 */
import { createHmac, timingSafeEqual } from 'crypto';

export const SNAPSHOT_SEAL_DOMAIN = 'isaflow:audit-snapshot:v1';
export const CHECK_RUN_SEAL_DOMAIN = 'isaflow:audit-check-run:v1';
export const PACK_SEAL_DOMAIN = 'isaflow:audit-pack:v1';
export const PACK_ZIP_SEAL_DOMAIN = 'isaflow:audit-pack-zip:v1';
const MIN_KEY_LENGTH = 32;

export class SigningKeyMissingError extends Error {
  constructor(message = 'Audit snapshots are not available: the signing key (AUDIT_SNAPSHOT_SIGNING_KEY, AUDIT_SNAPSHOT_KEY_ID) is not configured.') {
    super(message);
    this.name = 'SigningKeyMissingError';
  }
}

/** A retired key: verifies seals taken before `retiredAt` (epoch ms) only. */
export interface RetiredKey { key: Buffer; retiredAt: number }

export interface SigningKey { key: Buffer; keyId: string; retired?: ReadonlyMap<string, RetiredKey> }

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export function signingKey(): SigningKey {
  const raw = process.env.AUDIT_SNAPSHOT_SIGNING_KEY ?? '';
  const keyId = (process.env.AUDIT_SNAPSHOT_KEY_ID ?? '').trim();
  if (raw.length < MIN_KEY_LENGTH || keyId === '') throw new SigningKeyMissingError();
  const retired = new Map<string, RetiredKey>();
  for (const entry of (process.env.AUDIT_SNAPSHOT_RETIRED_KEYS ?? '').split(',').filter((e) => e.trim() !== '')) {
    const eq = entry.indexOf('=');
    const stamp = entry.lastIndexOf('@');
    const id = entry.slice(0, eq).trim();
    const secret = entry.slice(eq + 1, stamp);
    const when = entry.slice(stamp + 1).trim();
    const retiredAt = ISO_INSTANT.test(when) ? Date.parse(when) : NaN;
    // A malformed entry is a configuration error, never skipped: skipped, every seal under that key would read forged.
    if (!(eq > 0 && stamp > eq && id !== keyId && secret.length >= MIN_KEY_LENGTH && Number.isFinite(retiredAt))) {
      throw new SigningKeyMissingError(`Audit snapshots are not available: AUDIT_SNAPSHOT_RETIRED_KEYS has an entry that is not `
        + `id=secret@retired-at (secret ≥ ${MIN_KEY_LENGTH} characters, an ISO instant, not the current key id): "${id || '?'}".`);
    }
    retired.set(id, { key: Buffer.from(secret, 'utf8'), retiredAt });
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

/**
 * Timing-safe: the comparison does not stop at the first differing byte. `sealedAt`: when the seal was made, as the
 * database recorded it — a retired key vouches only for seals made before it was retired. Defaults to `f.takenAt`
 * (the writer's now() for snapshots and check runs); a pack passes its database-stamped built_at, because the time
 * inside its manifest is the forger's to write.
 */
export function checkSeal(domain: string, f: SealFields, hmac: string, keyId: string, k: SigningKey = signingKey(),
  sealedAt: string = f.takenAt): SealCheck {
  const old = keyId === k.keyId ? null : k.retired?.get(keyId);
  if (old && !(Date.parse(sealedAt) < old.retiredAt)) return 'invalid';
  const key = keyId === k.keyId ? k.key : old?.key;
  if (!key) return 'invalid';
  const expected = Buffer.from(hmacHex(key, sealMessage(domain, f)), 'hex');
  const given = Buffer.from(/^[0-9a-f]{64}$/.test(hmac) ? hmac : '', 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected) ? 'valid' : 'invalid';
}
