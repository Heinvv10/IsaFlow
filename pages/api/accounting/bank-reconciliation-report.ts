/**
 * Bank Reconciliation Report Data API
 * GET /api/accounting/bank-reconciliation-report?bankAccountId=<uuid>
 *
 * Returns matched and unmatched transaction data alongside statement balances
 * for rendering the PDF reconciliation report on the client.
 *
 * Bounded: each of the two lists carries at most `limit` rows (default and maximum REPORT_ROWS_MAX), in (date, id)
 * order, starting after the keyset cursor `matchedAfter` / `unmatchedAfter` ("YYYY-MM-DD,<uuid>", as returned in
 * `nextMatchedAfter` / `nextUnmatchedAfter`: the last row returned, null for an empty page). Keyset, not offset: a line inserted between two pages can neither repeat
 * a row nor skip one. `truncated` says which list has more rows than were returned, so a caller can page or warn
 * instead of presenting a partial list as the whole. bankAccountId must be a UUID; a bad cursor or limit is a 400.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { UUID } from '@/lib/schemas/common';
import { isLedgerDate, parseBoundedInt } from '@/modules/accounting/services/gl/ledgerDateRange';

export const REPORT_ROWS_MAX = 5000;

// ─── Row types returned from DB ───────────────────────────────────────────────

type TxRow = {
  id: string;
  transaction_date: string | Date;
  description: string | null;
  reference: string | null;
  amount: string | number;
  journal_entry_number: string | null;
  cursor_date: string;
};

type BatchRow = {
  opening_balance: string | null;
  closing_balance: string | null;
  statement_date: string | Date;
};

type AccountRow = {
  account_name: string;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toDateStr(d: string | Date): string {
  return fmtDate(d);
}

type Cursor = { date: string; id: string };
const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}),(.+)$/;
/** undefined/absent = from the start; a present cursor that is not "date,uuid" is null (the caller answers 400). */
function parseCursor(v: unknown): Cursor | null | undefined {
  if (v === undefined) return undefined;
  const m = typeof v === 'string' ? CURSOR_RE.exec(v) : null;
  if (!m || !isLedgerDate(m[1]!) || !UUID.safeParse(m[2]).success) return null;
  return { date: m[1]!, id: m[2]! };
}
const cursorOf = (r: TxRow | undefined): string | null => (r ? `${r.cursor_date},${r.id}` : null);

async function fetchBankAccountName(companyId: string, bankAccountId: string): Promise<string> {
  const rows = (await sql`
    SELECT account_name
    FROM gl_accounts
    WHERE id = ${bankAccountId}::UUID AND company_id = ${companyId}
    LIMIT 1
  `) as AccountRow[];
  return rows[0]?.account_name ?? 'Unknown Account';
}

async function fetchLatestBatch(companyId: string, bankAccountId: string): Promise<BatchRow | null> {
  const rows = (await sql`
    SELECT opening_balance, closing_balance, statement_date
    FROM bank_import_batches
    WHERE bank_account_id = ${bankAccountId}::UUID AND company_id = ${companyId}::UUID
    ORDER BY created_at DESC
    LIMIT 1
  `) as BatchRow[];
  return rows[0] ?? null;
}

async function fetchMatchedTransactions(companyId: string, bankAccountId: string, limit: number, after: Cursor | null): Promise<TxRow[]> {
  return (await sql`
    SELECT
      bt.id,
      bt.transaction_date,
      bt.description,
      bt.reference,
      bt.amount,
      je.entry_number AS journal_entry_number,
      to_char(bt.transaction_date, 'YYYY-MM-DD') AS cursor_date
    FROM bank_transactions bt
    LEFT JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id AND jl.company_id = ${companyId}::UUID
    LEFT JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = ${companyId}::UUID
    WHERE bt.bank_account_id = ${bankAccountId}::UUID
      AND bt.status = 'matched'
      AND bt.feed_state = 'posted'
      AND bt.company_id = ${companyId}
      AND (${after?.date ?? null}::DATE IS NULL OR (bt.transaction_date, bt.id) > (${after?.date ?? null}::DATE, ${after?.id ?? null}::UUID))
    ORDER BY bt.transaction_date, bt.id
    LIMIT ${limit + 1}::INT
  `) as TxRow[];
}

async function fetchUnmatchedTransactions(companyId: string, bankAccountId: string, limit: number, after: Cursor | null): Promise<TxRow[]> {
  return (await sql`
    SELECT
      bt.id,
      bt.transaction_date,
      bt.description,
      bt.reference,
      bt.amount,
      NULL::TEXT AS journal_entry_number,
      to_char(bt.transaction_date, 'YYYY-MM-DD') AS cursor_date
    FROM bank_transactions bt
    WHERE bt.bank_account_id = ${bankAccountId}::UUID
      AND bt.status = 'imported'
      AND bt.feed_state = 'posted'
      AND bt.company_id = ${companyId}
      AND (${after?.date ?? null}::DATE IS NULL OR (bt.transaction_date, bt.id) > (${after?.date ?? null}::DATE, ${after?.id ?? null}::UUID))
    ORDER BY bt.transaction_date, bt.id
    LIMIT ${limit + 1}::INT
  `) as TxRow[];
}

async function fetchTotals(companyId: string, bankAccountId: string): Promise<{ matched: number; unmatched: number }> {
  const [r] = (await sql`
    SELECT COUNT(*) FILTER (WHERE bt.status = 'matched')::INT AS matched,
           COUNT(*) FILTER (WHERE bt.status = 'imported')::INT AS unmatched
    FROM bank_transactions bt
    WHERE bt.bank_account_id = ${bankAccountId}::UUID AND bt.feed_state = 'posted' AND bt.company_id = ${companyId}
  `) as Array<{ matched: number; unmatched: number }>;
  return { matched: Number(r?.matched ?? 0), unmatched: Number(r?.unmatched ?? 0) };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const parsedId = UUID.safeParse(req.query.bankAccountId);
  if (!parsedId.success) return apiResponse.badRequest(res, 'bankAccountId must be a valid UUID');
  const bankAccountId = parsedId.data;
  // A paging parameter that is present must be valid: an out-of-range or garbled one is a 400, never a silent page 1.
  const paging = (name: string, min: number, max: number, dflt: number): number | null => {
    const v = req.query[name];
    return v === undefined ? dflt : parseBoundedInt(v, min, max);
  };
  if (req.query.matchedOffset !== undefined || req.query.unmatchedOffset !== undefined) {
    return apiResponse.badRequest(res, 'matchedOffset / unmatchedOffset are no longer supported: use the matchedAfter / unmatchedAfter cursors');
  }
  const limit = paging('limit', 1, REPORT_ROWS_MAX, REPORT_ROWS_MAX);
  const matchedAfter = parseCursor(req.query.matchedAfter);
  const unmatchedAfter = parseCursor(req.query.unmatchedAfter);
  if (limit === null || matchedAfter === null || unmatchedAfter === null) {
    return apiResponse.badRequest(res,
      `limit must be 1 to ${REPORT_ROWS_MAX} and matchedAfter / unmatchedAfter a cursor from a previous page ("YYYY-MM-DD,<uuid>")`);
  }

  try {
    // Parallel fetch: account name, latest batch, matched and unmatched transactions (one row past each limit, to know).
    const [bankAccountName, latestBatch, matchedAll, unmatchedAll, totals] = await Promise.all([
      fetchBankAccountName(companyId, bankAccountId),
      fetchLatestBatch(companyId, bankAccountId),
      fetchMatchedTransactions(companyId, bankAccountId, limit, matchedAfter ?? null),
      fetchUnmatchedTransactions(companyId, bankAccountId, limit, unmatchedAfter ?? null),
      fetchTotals(companyId, bankAccountId),
    ]);
    const matchedRows = matchedAll.slice(0, limit);
    const unmatchedRows = unmatchedAll.slice(0, limit);

    const mapTx = (row: TxRow) => ({
      date: toDateStr(row.transaction_date),
      description: row.description ?? '',
      amount: Number(row.amount),
      reference: row.reference ?? undefined,
      journalRef: row.journal_entry_number ?? undefined,
    });

    return apiResponse.success(res, {
      bankAccountName,
      statementDate: latestBatch ? toDateStr(latestBatch.statement_date) : '',
      openingBalance:
        latestBatch?.opening_balance !== null && latestBatch?.opening_balance !== undefined
          ? Number(latestBatch.opening_balance)
          : null,
      closingBalance:
        latestBatch?.closing_balance !== null && latestBatch?.closing_balance !== undefined
          ? Number(latestBatch.closing_balance)
          : null,
      matchedTransactions: matchedRows.map(mapTx),
      unmatchedTransactions: unmatchedRows.map(mapTx),
      truncated: { matched: matchedAll.length > limit, unmatched: unmatchedAll.length > limit },
      nextMatchedAfter: cursorOf(matchedRows[matchedRows.length - 1]),
      nextUnmatchedAfter: cursorOf(unmatchedRows[unmatchedRows.length - 1]),
      matchedTotal: totals.matched,
      unmatchedTotal: totals.unmatched,
    });
  } catch (err) {
    log.error('Failed to get bank reconciliation report data', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to get bank reconciliation report data');
  }
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
