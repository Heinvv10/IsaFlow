/**
 * The one keyset cursor every paginated report uses.
 *
 * Generalised from `tools/glAccountCursor.ts`, which already had this right and
 * whose reasoning stands: a cursor NAMES THE LAST ROW SERVED rather than an
 * offset, so a concurrent insert cannot shift the pages such that one row is
 * served twice or never. On an assurance report that is not a nicety — a
 * general ledger extracted across six pages while an agent is posting must not
 * silently skip a journal.
 *
 * Six teams building six paginated reports will otherwise invent six cursors.
 * This is the one. `glAccountCursor` stays as-is (it is in production and its
 * encoding is on the wire); new reports use this.
 */

/**
 * The sort key of the last row on a page. Every element must be a string so the
 * ordering is total and stable across the wire — format numbers and dates
 * before they get here (dates as YYYY-MM-DD, numbers zero-padded or as the
 * row's id).
 */
export interface CursorKey {
  /** Ordered sort-key parts, most significant first. Last part MUST be unique (the row id). */
  parts: readonly string[];
}

const MAX_CURSOR_CHARS = 512;
const MAX_PARTS = 6;

export function encodeCursor(key: CursorKey): string {
  if (key.parts.length === 0) throw new Error('cursor needs at least one part');
  if (key.parts.length > MAX_PARTS) throw new Error(`cursor takes at most ${MAX_PARTS} parts`);
  return Buffer.from(JSON.stringify(key.parts), 'utf8').toString('base64url');
}

/**
 * Returns null for anything this module did not produce — a malformed cursor is
 * a caller error, not a server error, and the tool should say "invalid cursor"
 * rather than throw a cast error inside a read transaction that has no savepoint.
 */
export function decodeCursor(raw: string, expectedParts: number): CursorKey | null {
  if (!raw || raw.length > MAX_CURSOR_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== expectedParts) return null;
  if (!parsed.every((p) => typeof p === 'string')) return null;
  return { parts: parsed as string[] };
}

/** Total order matching the page ordering. Lexicographic, part by part. */
export function compareCursorKeys(a: CursorKey, b: CursorKey): number {
  const len = Math.min(a.parts.length, b.parts.length);
  for (let i = 0; i < len; i++) {
    const x = a.parts[i]!;
    const y = b.parts[i]!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.parts.length - b.parts.length;
}

/**
 * SQL fragment guidance (documented, not generated — every query here uses the
 * `sql` tagged template and builds its own predicate):
 *
 *   WHERE (sort_a, sort_b, id) > (${cursor.parts[0]}, ${cursor.parts[1]}, ${cursor.parts[2]})
 *   ORDER BY sort_a, sort_b, id
 *   LIMIT ${limit + 1}
 *
 * Fetch `limit + 1` rows: the extra row is how you know whether to emit a
 * `next_cursor`, without a second COUNT. `rowsTotal` still needs its own count —
 * do not infer it from the page.
 */
export const CURSOR_SQL_NOTE = 'see compareCursorKeys doc comment' as const;
