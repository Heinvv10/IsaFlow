/**
 * Year-end close: roll the P&L into retained earnings and lock the year.
 *
 * Split out of `yearEndService` (which kept the read-side `listFiscalYears`)
 * when the close gained a dry run and outgrew the 300-line cap.
 *
 * ── WHY THE DRY RUN IS THE IMPORTANT HALF ───────────────────────────────────
 *
 * Brightsphere has four unclosed year-ends and R8.46m of retained earnings with
 * no journal lines behind it, so equity is a computed residual and the balance
 * sheet balancing proves nothing. Closing those years posts four journals that
 * move a decade of trading into equity and then LOCKS every period, which is
 * not a call anyone should make sight-unseen. `dryRun` runs every guard the
 * live call runs, reports the periods that block it BY NAME, and returns the
 * journal line by line. Only the write is skipped.
 *
 * ── TWO DEFECTS FIXED IN PASSING ────────────────────────────────────────────
 *
 * 1. The `retained_earnings_account` setting was read from `app_settings` with
 *    NO company_id predicate, on a view that has a `company_id` column. One
 *    tenant's setting would have chosen another tenant's equity account. There
 *    are zero rows in that view today, so it was latent — and it is exactly the
 *    kind of latent that becomes real the first time somebody configures it.
 *
 * 2. The account lookup was `LIMIT 1` with no `ORDER BY` over
 *    `account_code = X OR account_name ILIKE '%retained earnings%'`. With both
 *    a code match and a name match present, which one wins is physical row
 *    order — the same class of defect migration 525 was written for. The code
 *    match is now preferred explicitly.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
import { getFiscalPeriodIdForDate } from './fiscalPeriodService';
import { getFiscalYearStartMonth } from './fiscalYearBasis';
import { buildPreview, loadPLBalances, resolveRetainedEarnings } from './yearEndJournalBuilder';
import {
  alreadyClosedResult, findClosingJournal, isClosingNumberConflict, postClosingJournal,
} from './yearEndJournalPoster';
import { fiscalYearRange } from './fiscalYearCalendar';

export interface YearEndJournalLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
}

export interface YearEndJournalPreview {
  /** The year's last day — where the closing journal lands. */
  entryDate: string;
  entryNumber: string;
  description: string;
  lines: YearEndJournalLine[];
  totalDebit: number;
  totalCredit: number;
}

export interface CloseYearResult {
  /**
   * NULL for a year with nothing to close. A dormant year — no posted P&L
   * movement at all — has an empty journal, and an empty journal is not a
   * legal one to write. The year still CLOSES: every period is locked, which
   * is the part callers act on. `periodsLocked` says so without making them
   * read the null.
   */
  closingEntry: Record<string, unknown> | null;
  /**
   * How many periods carry `locked` for this year — counted, never assumed.
   * On a close that wrote, this is the UPDATE's row count; on an already-closed
   * year it is a read, because that call locks nothing.
   */
  periodsLocked: number;
  /** True when the year already had a posted closing journal and nothing was written. */
  alreadyClosed: boolean;
  netIncome: number;
  /**
   * P&L posted INSIDE an already-closed year that is NOT in its closing journal
   * — zero on every other path. Nothing stops a posted journal landing in a
   * locked year, and once one does the entry number is taken, so this service
   * can never sweep it into equity. See `alreadyClosedResult`.
   */
  unclosedNetIncome: number;
  message: string;
}

export interface CloseYearDryRunResult {
  dryRun: true;
  netIncome: number;
  preview: YearEndJournalPreview;
  /**
   * True when the year already has a posted closing journal (K-113).
   *
   * A closed year's aggregates are flat — its own closing journal is what
   * flattened them — so `netIncome: 0` with an EMPTY preview is exactly what a
   * company that never traded returns. The dry run is the read a person makes
   * before authorising the irreversible half, and telling them a year that
   * traded and was closed is empty is a false statement about the books.
   */
  alreadyClosed: boolean;
  /** The existing closing journal, when `alreadyClosed`. */
  existingEntry: Record<string, unknown> | null;
}

export type CloseYearError =
  | { error: 'open_periods'; count: number; openPeriods: Array<{ id: string; periodName: string; periodNumber: number }> }
  | { error: 'year_not_found' }
  | { error: 'no_retained_earnings' }
  | { error: 'ambiguous_retained_earnings'; accountCodes: string[] }
  | { error: 'no_fiscal_period'; entryDate: string }
  | {
      /**
       * The year has a `year_end` header that is NOT posted — reversed, or left
       * in draft. The year is not closed, and it also cannot be closed while
       * that row holds the entry number.
       */
      error: 'closing_journal_not_posted';
      entryNumber: string;
      entryId: string;
      status: string;
    }
  | {
      /**
       * A journal that is NOT a year-end close already carries `YE-<year>`.
       * `uq_gl_je_company_entry_number` has no source predicate, so the year is
       * unclosable until that row is renumbered.
       */
      error: 'closing_entry_number_taken';
      entryNumber: string;
      entryId: string;
      source: string;
      status: string;
    }
  | {
      error: 'period_range_mismatch';
      expected: { startDate: string; endDate: string };
      actual: { startDate: string; endDate: string };
      startMonth: number;
    };

export interface CloseYearOptions {
  /** Run every guard and return the journal, writing nothing. */
  dryRun?: boolean;
}

export async function closeFiscalYear(
  companyId: string,
  yearLabel: string,
  userId: string,
  options: CloseYearOptions = {},
): Promise<CloseYearResult | CloseYearDryRunResult | CloseYearError> {
  const dryRun = options.dryRun === true;

  // 1. Every period must be closed. Named, not counted: "3 periods are open" is
  //    not something a caller can act on.
  const openRows = (await sql`
    SELECT id, period_name, period_number FROM fiscal_periods
    WHERE fiscal_year = ${yearLabel} AND company_id = ${companyId} AND status = 'open'
    ORDER BY period_number
  `) as Record<string, unknown>[];
  if (openRows.length > 0) {
    return {
      error: 'open_periods',
      count: openRows.length,
      openPeriods: openRows.map((r) => ({
        id: String(r.id),
        periodName: String(r.period_name),
        periodNumber: Number(r.period_number),
      })),
    };
  }

  // 2. The year's date range.
  const rangeRows = await sql`
    SELECT MIN(start_date) AS start_date, MAX(end_date) AS end_date
    FROM fiscal_periods WHERE fiscal_year = ${yearLabel} AND company_id = ${companyId}
  `;
  const yearRange = rangeRows[0];
  if (!yearRange || yearRange.start_date === null) return { error: 'year_not_found' };

  // 2a. The periods must actually BE this company's fiscal year.
  //
  // Brightsphere's "fiscal year 2026" runs 1 Jan – 31 Dec 2026 while its
  // declared financial year starts in March, so the real FY2026 is
  // 1 Mar 2025 – 28 Feb 2026. Closing the calendar span rolls the WRONG twelve
  // months into retained earnings and then LOCKS every period behind it —
  // and nothing about the arithmetic looks wrong afterwards, because the
  // journal balances either way.
  //
  // No fallback on the start month. This is a write path; assuming March for a
  // company genuinely on a December year end produces a close a quarter out,
  // silently.
  const startMonth = await getFiscalYearStartMonth(companyId);
  const expected = fiscalYearRange(Number(yearLabel), startMonth);
  const actual = { startDate: fmtDate(yearRange.start_date), endDate: fmtDate(yearRange.end_date) };
  if (actual.startDate !== expected.startDate || actual.endDate !== expected.endDate) {
    return { error: 'period_range_mismatch', expected, actual, startMonth };
  }

  const { revenueAccounts, expenseAccounts } = await loadPLBalances(
    companyId, yearRange.start_date, yearRange.end_date,
  );

  const totalRevenue = revenueAccounts.reduce((s, a) => s + Number(a.balance), 0);
  const totalExpenses = expenseAccounts.reduce((s, a) => s + Number(a.balance), 0);
  const netIncome = totalRevenue - totalExpenses;

  const retained = await resolveRetainedEarnings(companyId);
  if ('error' in retained) return retained;

  const preview = buildPreview(
    yearLabel, fmtDate(yearRange.end_date), revenueAccounts, expenseAccounts, retained, netIncome,
  );

  // BEFORE the dry-run return, and before the write: both halves have to tell
  // an already-closed year apart from a dormant one, and a re-run after P&L
  // landed in the closed year has a NON-empty preview, so it used to reach the
  // INSERT and die on uq_gl_je_company_entry_number as a raw 23505.
  const existing = await findClosingJournal(companyId, preview.entryNumber);
  if (existing && String(existing.source) !== 'year_end') {
    return {
      error: 'closing_entry_number_taken',
      entryNumber: preview.entryNumber,
      entryId: String(existing.id),
      source: String(existing.source),
      status: String(existing.status),
    };
  }
  if (existing && existing.status !== 'posted') {
    return {
      error: 'closing_journal_not_posted',
      entryNumber: preview.entryNumber,
      entryId: String(existing.id),
      status: String(existing.status),
    };
  }
  const existingEntry = existing;

  if (dryRun) {
    return { dryRun: true, netIncome, preview, alreadyClosed: existingEntry !== null, existingEntry };
  }

  if (existingEntry) {
    return alreadyClosedResult(companyId, yearLabel, existingEntry, netIncome, yearRange);
  }

  let closingEntry: Record<string, unknown> | null;
  let periodsLocked: number;
  try {
    // Resolved BEFORE the transaction opens, and only where a journal is
    // actually written. A journal with a NULL fiscal_period_id is outside the
    // trial balance, the VAT201 and the AFS permanently, and this one is
    // followed immediately by LOCKING every period in the year — so an
    // unstamped year-end journal could never be corrected in place afterwards.
    // The raw INSERT bypasses createJournalEntry, which resolves the period
    // everywhere else. A DORMANT year writes no journal, so refusing it for
    // want of a period to stamp would block a close that stamps nothing.
    let fiscalPeriodId: string | null = null;
    if (preview.lines.length > 0) {
      fiscalPeriodId = await getFiscalPeriodIdForDate(companyId, preview.entryDate);
      if (!fiscalPeriodId) return { error: 'no_fiscal_period', entryDate: preview.entryDate };
    }

    ({ entry: closingEntry, periodsLocked } = await postClosingJournal(
      companyId, userId, yearLabel, preview, fiscalPeriodId,
    ));
  } catch (err) {
    // The lookup above is a separate statement from the INSERT, so two
    // simultaneous closes both read `null` and both arrive here. The unique
    // index holds the ledger — one journal, never two — and the loser's whole
    // transaction rolled back, so it wrote nothing. What it must NOT do is
    // answer 500 for a year that is now correctly closed.
    if (!isClosingNumberConflict(err)) throw err;
    const winner = await findClosingJournal(companyId, preview.entryNumber);
    // Only a POSTED year_end row means the year is closed. Anything else that
    // took the number between the lookup and the INSERT is not a close, and
    // calling it one would be the lie this branch exists to avoid.
    if (!winner || String(winner.source) !== 'year_end' || winner.status !== 'posted') throw err;
    log.info('Year-end close lost the race for the closing entry number; reporting the winner',
      { companyId, year: yearLabel, entryId: winner.id, module: 'accounting' });
    return alreadyClosedResult(companyId, yearLabel, winner, netIncome, yearRange);
  }

  log.info('Year-end processed', {
    year: yearLabel, entryId: closingEntry?.id ?? null, periodsLocked, netIncome, module: 'accounting',
  });

  return {
    closingEntry,
    periodsLocked,
    alreadyClosed: false,
    netIncome,
    unclosedNetIncome: 0,
    message: closingEntry
      ? `Year ${yearLabel} closed. Net income R${netIncome.toFixed(2)} transferred to Retained Earnings.`
      : `Year ${yearLabel} closed. No posted profit or loss in the year, so no closing journal was needed.`,
  };
}
