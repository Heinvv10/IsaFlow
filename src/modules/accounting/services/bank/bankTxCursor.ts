/**
 * PRD-11 §3 — keyset cursor for bank-transaction paging.
 *
 * An offset page over a live import double-reads rows (a concurrent insert
 * shifts every subsequent page), so the MCP agent pages by keyset instead.
 * The cursor is an opaque base64url JSON `{ d, a, id }` keyed on the exact
 * ORDER BY tuple: `(transaction_date, amount, id)`. `id` is the final tiebreak
 * that makes the ordering TOTAL — without it two same-date/same-amount rows can
 * swap places between pages and one of them is never returned.
 *
 * Keep the predicate and the ORDER BY in lockstep: a mismatch silently skips
 * or repeats rows rather than erroring.
 */
import { sql } from '@/lib/neon';

export interface BankTxCursor {
  /** transaction_date, 'YYYY-MM-DD' */
  d: string;
  /** amount */
  a: number;
  /** bank_transactions.id */
  id: string;
}

/** Thrown for an unparseable / wrong-shaped cursor. Callers map it to a 400-ish
 *  reply (MCP: `toolError('invalid cursor')`) rather than a generic 500. */
export class InvalidCursorError extends Error {
  constructor(message = 'Invalid cursor') {
    super(message);
    this.name = 'InvalidCursorError';
  }
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MAX_CURSOR_CHARS = 512;

/**
 * Shape is not enough: '2026-13-45' matches the pattern and reaches Postgres as
 * `$N::DATE`, which throws 22008. Read tools run with no savepoint, so that
 * aborts the whole request transaction — the registry's refund and audit writes
 * then fail with 25P02 and the caller gets a 500 with the Flow debit unrefunded.
 * Every cursor field is validated here, before any of it reaches SQL.
 */
function isRealDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function encodeBankTxCursor(cursor: BankTxCursor): string {
  return Buffer.from(JSON.stringify({ d: cursor.d, a: cursor.a, id: cursor.id }), 'utf8')
    .toString('base64url');
}

export function decodeBankTxCursor(raw: string): BankTxCursor {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_CURSOR_CHARS) {
    throw new InvalidCursorError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  if (!parsed || typeof parsed !== 'object') throw new InvalidCursorError();
  const { d, a, id } = parsed as Record<string, unknown>;
  if (typeof d !== 'string' || !isRealDate(d)) throw new InvalidCursorError();
  if (typeof a !== 'number' || !Number.isFinite(a)) throw new InvalidCursorError();
  // `id` is cast to ::UUID; anything else is a 22P02 with the same cascade.
  if (typeof id !== 'string' || !UUID.test(id.trim())) throw new InvalidCursorError();
  return { d, a, id: id.trim() };
}

/**
 * Keyset predicate fragment matching `ORDER BY transaction_date <dir>, amount DESC, id DESC`.
 * Returns an empty fragment when there is no cursor. Values travel as bound
 * parameters inside the fragment (`sql.unsafe` renumbers `$N` on splice) — no
 * user value is ever concatenated into SQL text.
 */
export function bankTxKeysetCond(cursor: BankTxCursor | undefined, dateDir: 'ASC' | 'DESC') {
  if (!cursor) return sql.unsafe('');
  const values = [cursor.d, cursor.a, cursor.id];
  // amount/id stay DESC in both orderings, so only the date leg flips.
  if (dateDir === 'ASC') {
    return sql.unsafe(
      `AND (bt.transaction_date > $1::DATE
            OR (bt.transaction_date = $1::DATE
                AND (bt.amount, bt.id) < ($2::NUMERIC, $3::UUID)))`,
      values,
    );
  }
  return sql.unsafe(
    'AND (bt.transaction_date, bt.amount, bt.id) < ($1::DATE, $2::NUMERIC, $3::UUID)',
    values,
  );
}
