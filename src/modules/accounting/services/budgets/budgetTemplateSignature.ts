/**
 * The budget template's signature (ruling Q4): `_meta` carries an HMAC over the version, year,
 * grain and token the file was cut with and a SHA-256 of the `_base` sheet's content, so the
 * downloaded amounts cannot be forged to hide a revert. The key is derived from the server's
 * existing JWT_SECRET for this purpose only (the `impersonationAssurance` pattern); no new secret.
 *
 * The content is hashed from the cells as written and as read back (text as is, numbers as JS
 * prints them, trailing empty cells dropped), not from the XML, so a re-save by Excel keeps it.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const PURPOSE = 'isaflow:budget-template-base:v1';

/** A `_base` cell as written or read: text, a number, empty, or something no writer of ours produces. */
export type SignedCell = string | number | null | undefined | { error: string };

function key(): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not set');
  return createHmac('sha256', secret).update(PURPOSE).digest();
}

/** SHA-256 (hex) of the `_base` rows, header included. */
export function baseDigest(rows: ReadonlyArray<ReadonlyArray<SignedCell>>): string {
  const hash = createHash('sha256');
  for (const row of rows) {
    const cells = row.map((c) => (c === null || c === undefined ? '' : typeof c === 'object' ? '\u0000' : String(c)));
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    hash.update(cells.join('\u001f')).update('\u001e');
  }
  return hash.digest('hex');
}

export interface SignedMeta { versionId: string; fiscalYear: number; grain: string; updatedAt: string }

/** The signature `_meta` carries (hex). */
export function templateSignature(meta: SignedMeta, digest: string): string {
  return createHmac('sha256', key()).update([meta.versionId, meta.fiscalYear, meta.grain, meta.updatedAt, digest].join('|')).digest('hex');
}

/** True when `given` is the signature of `meta` and `digest`. */
export function signatureMatches(meta: SignedMeta, digest: string, given: string): boolean {
  const expected = Buffer.from(templateSignature(meta, digest), 'hex');
  const actual = /^[0-9a-f]{64}$/.test(given) ? Buffer.from(given, 'hex') : Buffer.alloc(0);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
