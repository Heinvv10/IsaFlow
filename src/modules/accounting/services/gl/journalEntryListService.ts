/**
 * Agent-facing journal listing across ALL accounts, with keyset paging.
 *
 * `getJournalEntries` (journalEntryCrudService) serves the UI: offset paging,
 * no date range, and it hides `auto_%` sources. An agent reviewing a period
 * needs the opposite — a date window, every source, and a cursor that cannot
 * double-read while postings land concurrently. One null-safe query replaces
 * the UI service's four-branch SQL.
 *
 * Cursor: opaque base64url JSON `{ d, c, id }` over the exact ORDER BY tuple
 * `(entry_date DESC, created_at DESC, id DESC)`. Keep predicate and ORDER BY
 * in lockstep — a mismatch skips or repeats rows silently.
 *
 * `status='reversed'` maps to `reversed_at IS NOT NULL`: a reversal never
 * flips status in this codebase (the original stays 'posted').
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { UUID_RE, isRealCalendarDate } from '@/lib/validation';
import { InvalidCursorError } from '../bank/bankTxCursor';

export const JOURNAL_LIST_STATUSES = ['draft', 'posted', 'reversed'] as const;
export type JournalListStatus = (typeof JOURNAL_LIST_STATUSES)[number];

export interface JournalListFilters {
  fromDate?: string;
  toDate?: string;
  status?: JournalListStatus;
  source?: string;
  /** Only journals with at least one line on this gl_accounts.id. */
  accountId?: string;
  limit?: number;
  cursor?: string;
  includeLines?: boolean;
}

export interface JournalListLine {
  accountId: string;
  accountCode: string | null;
  accountName: string | null;
  debit: number;
  credit: number;
  description: string | null;
}

export interface JournalListEntry {
  id: string;
  entryNumber: string;
  entryDate: string;
  description: string | null;
  source: string;
  status: string;
  postingAgent: string | null;
  reversed: boolean;
  reversalOfId: string | null;
  fiscalPeriodId: string | null;
  /** Sum of debits — the journal's size. */
  amount: number;
  lines?: JournalListLine[];
}

export interface JournalListPage {
  entries: JournalListEntry[];
  nextCursor: string | null;
}

interface JournalCursor { d: string; c: string; id: string }

const MAX_CURSOR_CHARS = 512;
const MAX_LIMIT = 100;

/**
 * created_at travels in the cursor as Postgres's own text rendering, NOT a JS
 * Date: toISOString() keeps milliseconds and Postgres keeps microseconds, so a
 * cursor built from a Date sits BELOW the row it names and every row sharing
 * that millisecond (a batch inserted in one transaction shares now()) is
 * skipped on the next page. The integration test caught exactly that.
 */
const PG_TIMESTAMPTZ_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

function encodeCursor(c: JournalCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

/** Every field is cast in SQL, so each is validated the way the tool validates its own args. */
export function decodeJournalCursor(raw: string): JournalCursor {
  if (typeof raw !== 'string' || !raw || raw.length > MAX_CURSOR_CHARS) throw new InvalidCursorError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  if (!parsed || typeof parsed !== 'object') throw new InvalidCursorError();
  const { d, c, id } = parsed as Record<string, unknown>;
  if (typeof d !== 'string' || !isRealCalendarDate(d)) throw new InvalidCursorError();
  if (typeof c !== 'string' || !PG_TIMESTAMPTZ_RE.test(c)) throw new InvalidCursorError();
  if (typeof id !== 'string' || !UUID_RE.test(id.trim())) throw new InvalidCursorError();
  return { d, c, id: id.trim() };
}

function mapEntry(r: DbRow): JournalListEntry {
  return {
    id: String(r.id),
    entryNumber: r.entry_number ? String(r.entry_number) : '',
    entryDate: fmtDate(r.entry_date),
    description: r.description ? String(r.description) : null,
    source: String(r.source ?? ''),
    status: String(r.status ?? ''),
    postingAgent: r.posting_agent ? String(r.posting_agent) : null,
    reversed: r.reversed_at != null,
    reversalOfId: r.reversal_of_id ? String(r.reversal_of_id) : null,
    fiscalPeriodId: r.fiscal_period_id ? String(r.fiscal_period_id) : null,
    amount: Number(r.amount ?? 0),
  };
}

async function fetchLines(companyId: string, entryIds: string[]): Promise<Map<string, JournalListLine[]>> {
  const byEntry = new Map<string, JournalListLine[]>();
  if (entryIds.length === 0) return byEntry;
  const rows = (await sql`
    SELECT jl.journal_entry_id, jl.gl_account_id, jl.debit, jl.credit, jl.description,
           a.account_code, a.account_name
    FROM gl_journal_lines jl
    LEFT JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.company_id = ${companyId}::UUID
    WHERE jl.company_id = ${companyId}::UUID
      AND jl.journal_entry_id = ANY(${entryIds}::UUID[])
    ORDER BY jl.journal_entry_id, jl.debit DESC, jl.credit DESC, jl.id
  `) as DbRow[];
  for (const r of rows) {
    const key = String(r.journal_entry_id);
    const list = byEntry.get(key) ?? [];
    list.push({
      accountId: String(r.gl_account_id),
      accountCode: r.account_code ? String(r.account_code) : null,
      accountName: r.account_name ? String(r.account_name) : null,
      debit: Number(r.debit ?? 0),
      credit: Number(r.credit ?? 0),
      description: r.description ? String(r.description) : null,
    });
    byEntry.set(key, list);
  }
  return byEntry;
}

export async function listJournalEntriesPage(
  companyId: string,
  filters: JournalListFilters = {},
): Promise<JournalListPage> {
  const raw = filters.limit;
  const limit = typeof raw === 'number' && Number.isFinite(raw) && raw > 0
    ? Math.min(Math.floor(raw), MAX_LIMIT)
    : 50;
  const cursor = filters.cursor ? decodeJournalCursor(filters.cursor) : null;
  const fromDate = filters.fromDate ?? null;
  const toDate = filters.toDate ?? null;
  const status = filters.status ?? null;
  const source = filters.source ?? null;
  const accountId = filters.accountId ?? null;
  const cd = cursor?.d ?? null;
  const cc = cursor?.c ?? null;
  const cid = cursor?.id ?? null;

  const rows = (await sql`
    SELECT je.id, je.entry_number, je.entry_date, je.description, je.source, je.status,
           je.posting_agent, je.reversed_at, je.reversal_of_id, je.fiscal_period_id,
           je.created_at::TEXT AS created_at_txt,
           COALESCE(SUM(jl.debit), 0) AS amount
    FROM gl_journal_entries je
    LEFT JOIN gl_journal_lines jl
      ON jl.journal_entry_id = je.id AND jl.company_id = ${companyId}::UUID
    WHERE je.company_id = ${companyId}::UUID
      AND (${fromDate}::DATE IS NULL OR je.entry_date >= ${fromDate}::DATE)
      AND (${toDate}::DATE IS NULL OR je.entry_date <= ${toDate}::DATE)
      AND (${status}::TEXT IS NULL
           OR (${status}::TEXT = 'reversed' AND je.reversed_at IS NOT NULL)
           OR (${status}::TEXT <> 'reversed' AND je.status = ${status}::TEXT))
      AND (${source}::TEXT IS NULL OR je.source = ${source}::TEXT)
      AND (${accountId}::UUID IS NULL OR EXISTS (
            SELECT 1 FROM gl_journal_lines x
            WHERE x.journal_entry_id = je.id
              AND x.company_id = ${companyId}::UUID
              AND x.gl_account_id = ${accountId}::UUID))
      AND (${cid}::UUID IS NULL
           OR (je.entry_date, je.created_at, je.id)
              < (${cd}::DATE, ${cc}::TIMESTAMPTZ, ${cid}::UUID))
    GROUP BY je.id
    ORDER BY je.entry_date DESC, je.created_at DESC, je.id DESC
    LIMIT ${limit}::INT + 1
  `) as DbRow[];

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const entries = pageRows.map(mapEntry);

  if (filters.includeLines && entries.length > 0) {
    const lines = await fetchLines(companyId, entries.map((e) => e.id));
    for (const e of entries) e.lines = lines.get(e.id) ?? [];
  }

  const last = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && last
    ? encodeCursor({ d: fmtDate(last.entry_date), c: String(last.created_at_txt), id: String(last.id) })
    : null;
  return { entries, nextCursor };
}
