/**
 * Keyset cursor for list_gl_accounts. The chart is filtered in memory, so the
 * cursor is not a SQL predicate — it names the last row served, and the next
 * page starts strictly after that row in the (account_code, id) ordering.
 * Naming the row rather than an offset means a concurrent create_gl_account
 * cannot shift the pages so that one account is served twice or never.
 */
import { UUID_RE } from '@/lib/validation';

export interface GlAccountCursor {
  code: string;
  id: string;
}

export interface GlAccountKey {
  accountCode: string;
  id: string;
}

const MAX_CURSOR_CHARS = 512;

export function encodeGlAccountCursor(last: GlAccountKey): string {
  return Buffer.from(JSON.stringify({ code: last.accountCode, id: last.id }), 'utf8')
    .toString('base64url');
}

/** Returns null for anything that is not a cursor this module produced. */
export function decodeGlAccountCursor(raw: string): GlAccountCursor | null {
  if (!raw || raw.length > MAX_CURSOR_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { code, id } = parsed as Record<string, unknown>;
  if (typeof code !== 'string' || typeof id !== 'string' || !UUID_RE.test(id)) return null;
  return { code, id };
}

/** Total order matching the page ordering: code, then id as the tiebreak. */
export function compareGlAccountKeys(a: GlAccountKey, b: GlAccountKey): number {
  if (a.accountCode !== b.accountCode) return a.accountCode < b.accountCode ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** Index of the first row strictly after the cursor in a list already sorted by compareGlAccountKeys. */
export function startIndexAfter(sorted: readonly GlAccountKey[], cursor: GlAccountCursor): number {
  const key: GlAccountKey = { accountCode: cursor.code, id: cursor.id };
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareGlAccountKeys(sorted[mid]!, key) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
