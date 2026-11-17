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

/**
 * The JSON template's per-row base (MCP budget tools PR 2, review round 1): a row's month values as read (cents,
 * null = not budgeted), signed with the same key as `_meta` over the version, financial year, grain, the year's month
 * list (round 2: the values are by position, so a year whose shape changed cannot misalign them) and the row's
 * account and member, so the JSON grid gets the .xlsx's 3-way diff (a row read on any page, at any token, is
 * compared with what IT was read with). Text: `v1:<account id>:<member id or ->:<cents,…>:<hmac hex>`.
 */
export interface RowBaseMeta { versionId: string; fiscalYear: number; grain: string; months: readonly string[] }
export interface RowBase { accountId: string; memberId: string | null; cents: Array<number | null> }

const ROW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROW_CENTS = /^-?\d{1,16}$/;

function rowSignature(meta: RowBaseMeta, accountId: string, memberId: string | null, values: string): Buffer {
  return createHmac('sha256', key()).update(['row-base:v1', meta.versionId.toLowerCase(), meta.fiscalYear, meta.grain, meta.months.join(','), accountId, memberId ?? '', values].join('|')).digest();
}

export function encodeRowBase(meta: RowBaseMeta, row: RowBase): string {
  const accountId = row.accountId.toLowerCase();
  const memberId = row.memberId === null ? null : row.memberId.toLowerCase();
  const values = row.cents.map((c) => (c === null ? '' : String(c))).join(',');
  return `v1:${accountId}:${memberId ?? '-'}:${values}:${rowSignature(meta, accountId, memberId, values).toString('hex')}`;
}

/** The row `text` encodes, or null when it is malformed, of another version, year, grain or month list, or altered. */
export function decodeRowBase(meta: RowBaseMeta, text: string): RowBase | null {
  const parts = text.split(':');
  if (parts.length !== 5 || parts[0] !== 'v1') return null;
  const [, accountId, member, values, sig] = parts as [string, string, string, string, string];
  const memberId = member === '-' ? null : member;
  if (!ROW_ID.test(accountId) || (memberId !== null && !ROW_ID.test(memberId)) || !/^[0-9a-f]{64}$/.test(sig)) return null;
  const raw = values.split(',');
  if (raw.length !== meta.months.length || raw.some((v) => v !== '' && !ROW_CENTS.test(v))) return null;
  const expected = rowSignature(meta, accountId, memberId, values);
  if (!timingSafeEqual(Buffer.from(sig, 'hex'), expected)) return null;
  return { accountId, memberId, cents: raw.map((v) => (v === '' ? null : Number(v) + 0)) }; // + 0: never -0
}
