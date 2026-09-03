/**
 * The shapes and the small arithmetic the general-ledger line stream shares.
 *
 * Split out of `generalLedgerStreamService` for the 300-line cap. The reasoning
 * that matters — why the running balance is computed over the whole period and
 * then keyset-filtered rather than carried in the cursor, and why a line-level
 * filter suppresses it — lives with the query in that file, because that is
 * where someone changing it will be looking.
 */

export interface GeneralLedgerCursor {
  accountCode: string;
  date: string;
  /**
   * The entry's `created_at` as 'YYYY-MM-DD HH24:MI:SS.US' in UTC —
   * MICROSECOND precision, because that is what Postgres stores.
   *
   * Not an ISO string from a JS `Date`. A round trip through `Date` truncates
   * to milliseconds, and a keyset comparison against the truncated value then
   * re-admits every row inside that millisecond: paging Brightsphere's ledger
   * returned 10,603 lines where 10,460 exist. The duplicates were at page
   * boundaries, which is the one place nobody looks.
   */
  createdKey: string;
  lineId: string;
}

export interface GeneralLedgerQuery {
  companyId: string;
  /** 'YYYY-MM-DD'. Strings throughout — no Date arithmetic on this path. */
  periodStart: string;
  periodEnd: string;
  /** Account-level filters. These preserve `runningBalance`. */
  accountCodes?: readonly string[];
  accountIds?: readonly string[];
  accountTypes?: readonly string[];
  /** Line-level filters. Any of these SUPPRESSES `runningBalance`. */
  sources?: readonly string[];
  minAmount?: number;
  /** Case-insensitive substring of the entry number or the description. */
  search?: string;
  limit: number;
  after?: GeneralLedgerCursor | null;
}

export interface GeneralLedgerLine {
  lineId: string;
  journalEntryId: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  /** Reported so a caller can re-derive the signed movement itself. */
  normalBalance: 'debit' | 'credit';
  date: string;
  entryNumber: string;
  description: string;
  source: string;
  debit: number;
  credit: number;
  /** Opening balance plus cumulative movement. Null under a line-level filter. */
  runningBalance: number | null;
}

export interface GeneralLedgerPage {
  lines: GeneralLedgerLine[];
  /** Keyset for the next page, or null at the end of the stream. */
  next: GeneralLedgerCursor | null;
  /** Over the WHOLE filtered set, never just this page. */
  lineCount: number;
  /**
   * Posted lines in the period BEFORE any filter — the universe the extract was
   * drawn from.
   *
   * The general ledger is the base document of an audit file, so this matters
   * more here than anywhere. Reporting the filtered count as the universe would
   * let the envelope certify a filtered extract as COMPLETE — rowsTotal equal
   * to universeTotal, nothing excluded, `truncated: false` — which is the
   * strongest claim the contract can make and the one claim a filtered extract
   * must never make.
   */
  universeLineCount: number;
  totalDebit: number;
  totalCredit: number;
  accountCount: number;
  /** True when the unfiltered period's debits equal its credits. Null when filtered. */
  balanced: boolean | null;
  runningBalanceSuppressed: boolean;
  /** Opening balance per account code, for every account in the filtered set. */
  openingBalances: Record<string, number>;
  /** MAX(created_at) of the lines consumed, ISO-8601. Null when none. Never now(). */
  postedThrough: string | null;
}

/** Anything below this is rounding, not a difference. */
export const BALANCE_TOLERANCE = 0.01;

export function round2(v: number): number {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
}

export function toIso(raw: unknown): string | null {
  if (raw == null) return null;
  return raw instanceof Date ? raw.toISOString() : String(raw);
}

export interface StreamTotals {
  lineCount: number;
  universeLineCount: number;
  totalDebit: number;
  totalCredit: number;
  accountCount: number;
  postedThrough: string | null;
  openingBalances: Record<string, number>;
}

export const EMPTY_TOTALS: StreamTotals = {
  lineCount: 0,
  universeLineCount: 0,
  totalDebit: 0,
  totalCredit: 0,
  accountCount: 0,
  postedThrough: null,
  openingBalances: {},
};

/** Parses the aggregated opening-balance JSON the stream query carries. */
export function openingMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  const parsed = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  if (!Array.isArray(parsed)) return out;
  for (const entry of parsed) {
    const e = entry as { c?: unknown; b?: unknown };
    if (typeof e.c === 'string') out[e.c] = round2(Number(e.b ?? 0));
  }
  return out;
}
