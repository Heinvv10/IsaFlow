/**
 * Year-end close rows for an income-statement account's ledger listing.
 *
 * Income-statement accounts restart at each fiscal-year start (trialBalanceBasis),
 * and every report reads the ledger as holding no year-end closing journals: the posted close
 * (source 'year_end') is skipped, because the close is derived. So a ledger listing of a
 * revenue or expense account must itself:
 *
 *   1. open at the start of the fiscal year containing `fromDate`, never from
 *      inception — `incomeStatementOpeningFloor`;
 *   2. when the range crosses a fiscal-year start, bring the balance to zero at
 *      that boundary with a row that says on its face it was derived, not
 *      posted — `closeRowAmounts` / `runWithYearEndCloses`.
 *
 * Then the closing balance at `toDate` equals the trial balance as at `toDate`
 * whatever `fromDate` was. Balance-sheet accounts get neither.
 *
 * "When does the fiscal year start" is NOT decided here: every date comes from
 * the fiscal-year registry (`fiscalYearRegistry`), so the boundaries are the
 * REAL years' edges: a 14-month transition year is one year, and a year before
 * a change of year end keeps the dates it had. Dates are 'YYYY-MM-DD' strings,
 * compared as strings, never round-tripped through a local-time `Date`.
 */

import { fmtDate } from '@/lib/fmtDate';
import { dayBefore, fiscalYearForDate, priorFiscalYear } from './fiscalYearRegistry';
import { isLedgerDate, LEDGER_MAX_YEAR, LEDGER_MIN_YEAR } from './ledgerDateRange';
import { INCOME_STATEMENT_TYPES } from './trialBalanceBasis';

export function isIncomeStatementType(accountType: string): boolean {
  return (INCOME_STATEMENT_TYPES as readonly string[]).includes(accountType);
}

/** First day of the fiscal year containing `fromDate` for revenue/expense; null (no floor) otherwise. */
export async function incomeStatementOpeningFloor(
  companyId: string,
  accountType: string,
  fromDate: string,
): Promise<string | null> {
  if (!isIncomeStatementType(accountType)) return null;
  return (await fiscalYearForDate(companyId, fromDate)).startDate;
}

/** More boundaries than the legal year range can hold; a walk that reaches it is a bug. */
const MAX_BOUNDARIES = LEDGER_MAX_YEAR - LEDGER_MIN_YEAR + 2;

/**
 * Fiscal-year start dates strictly after `fromDate` and on or before `toDate`, ascending.
 * Both must be real 'YYYY-MM-DD' dates (ledgerDateRange): the walk compares strings, so an
 * odd one (a leading space sorts below every digit) used to never end. Bounded three ways:
 * validated input, a walk back one registry year at a time (each strictly earlier), and an
 * iteration cap that throws.
 */
export async function fiscalYearStartsWithin(
  companyId: string,
  fromDate: string,
  toDate: string,
): Promise<string[]> {
  for (const d of [fromDate, toDate]) {
    if (!isLedgerDate(d)) throw new Error(`fiscalYearStartsWithin: invalid date '${String(d)}'`);
  }
  const out: string[] = [];
  let year = await fiscalYearForDate(companyId, toDate);
  while (year.startDate > fromDate) {
    if (out.length >= MAX_BOUNDARIES) {
      throw new Error('fiscalYearStartsWithin: fiscal-year walk did not terminate');
    }
    out.unshift(year.startDate);
    year = await priorFiscalYear(companyId, year);
  }
  return out;
}

/** The day after a 'YYYY-MM-DD' date, by integer components (no Date round-trip through UTC). */
export function dayAfter(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return fmtDate(new Date(y, m - 1, d + 1));
}

/** Last day of the fiscal year that ends immediately before `nextFyStart`. */
export function fiscalYearEndBefore(nextFyStart: string): string {
  return dayBefore(nextFyStart);
}

export function yearEndCloseDescription(fyEnd: string): string {
  return `Closed to retained earnings — FY ending ${fyEnd} (derived — not posted)`;
}

/**
 * Debit/credit that take a normal-side `balance` to zero. Rounded to cents so
 * float noise in the balance cannot leave a sub-cent residue behind the close.
 */
export function closeRowAmounts(
  balance: number,
  normalBalance: string,
): { debit: number; credit: number } {
  const amount = Math.round(Math.abs(balance) * 100) / 100;
  const reducesWithCredit = (normalBalance === 'debit') === balance > 0;
  return reducesWithCredit ? { debit: 0, credit: amount } : { debit: amount, credit: 0 };
}

export interface MovementRow {
  date: string;
  debit: number;
  credit: number;
}

/**
 * Running balance over date-ordered rows, inserting a close row at each
 * boundary the balance crosses with a non-zero balance. Returns the rows with
 * `balance` set, and the closing balance. For an in-memory (unpaginated) list.
 */
export function runWithYearEndCloses<T extends MovementRow>(
  rows: readonly T[],
  opts: {
    opening: number;
    normalBalance: string;
    boundaries: readonly string[];
    makeClose: (fyEnd: string, amounts: { debit: number; credit: number }) => T;
  },
): { rows: Array<T & { balance: number }>; closing: number } {
  const { normalBalance, boundaries, makeClose } = opts;
  const signed = (d: number, c: number) => (normalBalance === 'debit' ? d - c : c - d);
  const out: Array<T & { balance: number }> = [];
  let running = opts.opening;
  let next = 0;
  const closeUpTo = (date: string | null) => {
    while (next < boundaries.length && (date === null || date >= boundaries[next]!)) {
      const rounded = Math.round(running * 100) / 100;
      if (rounded !== 0) {
        out.push({ ...makeClose(fiscalYearEndBefore(boundaries[next]!), closeRowAmounts(rounded, normalBalance)), balance: 0 });
      }
      running = 0;
      next += 1;
    }
  };
  for (const row of rows) {
    closeUpTo(row.date);
    running += signed(row.debit, row.credit);
    out.push({ ...row, balance: running });
  }
  closeUpTo(null);
  return { rows: out, closing: running };
}
