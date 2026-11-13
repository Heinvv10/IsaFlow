/**
 * Row shaping for the general-ledger line stream (generalLedgerStreamService): the SQL rows of one page into lines, the
 * page's totals and the next keyset. Pure functions over the query's rows; no reads, no filters decided here.
 */
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { openingMap, round2, toIso, type GeneralLedgerCursor, type GeneralLedgerLine, type StreamTotals } from './generalLedgerStreamTypes';
import { runningBalanceIsDefined } from './generalLedgerStreamYearEnd';

/** The aggregates ride on every row and are identical, so any row (the first) carries them. */
export function totalsFromRow(agg: DbRow): StreamTotals {
  return {
    lineCount: Number(agg.line_count ?? 0),
    universeLineCount: Number(agg.universe_count ?? 0),
    totalDebit: round2(Number(agg.total_debit ?? 0)),
    totalCredit: round2(Number(agg.total_credit ?? 0)),
    accountCount: Number(agg.account_count ?? 0),
    postedThrough: toIso(agg.posted_through),
    openingBalances: openingMap(agg.opening_all),
  };
}

/** `lineLevelFilter` and `nullFrom` decide whether the running balance is withheld (see generalLedgerStreamService). */
export function lineFromRow(r: DbRow, lineLevelFilter: boolean, nullFrom: string | null): GeneralLedgerLine {
  return {
    lineId: String(r.line_id),
    journalEntryId: String(r.journal_entry_id),
    accountId: String(r.account_id),
    accountCode: String(r.account_code),
    accountName: String(r.account_name ?? ''),
    accountType: String(r.account_type ?? ''),
    normalBalance: String(r.normal_balance) === 'credit' ? 'credit' : 'debit',
    date: fmtDate(r.entry_date as string | Date),
    entryNumber: String(r.entry_number ?? ''),
    description: String(r.description ?? ''),
    source: String(r.source ?? 'manual'),
    debit: Number(r.debit ?? 0),
    credit: Number(r.credit ?? 0),
    runningBalance: lineLevelFilter || !runningBalanceIsDefined(
      String(r.account_type ?? ''), fmtDate(r.entry_date as string | Date), nullFrom)
      ? null
      : round2(Number(r.opening_balance ?? 0) + Number(r.cumulative ?? 0)),
  };
}

/** The keyset after the page's last row, or null when the page is short (the stream is exhausted). */
export function nextKeyset(rows: readonly DbRow[], limit: number): GeneralLedgerCursor | null {
  const last = rows[rows.length - 1];
  return last !== undefined && rows.length === limit
    ? {
        accountCode: String(last.account_code),
        date: fmtDate(last.entry_date as string | Date),
        createdKey: String(last.created_key),
        lineId: String(last.line_id),
      }
    : null;
}
