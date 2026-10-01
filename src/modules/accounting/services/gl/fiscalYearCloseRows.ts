/**
 * Year-end close rows for an income-statement account's ledger listing.
 *
 * Income-statement accounts restart at each fiscal-year start (trialBalanceBasis),
 * but the ledger holds no year-end closing journals. So a ledger listing of a
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
 * `fiscalYearBasis.fiscalYearStart` (owner of `fiscalyear.start.v1`). Dates are
 * 'YYYY-MM-DD' strings, compared as strings, never round-tripped through a
 * local-time `Date`.
 */

import { fiscalYearStart } from './fiscalYearBasis';
import { isLedgerDate, LEDGER_MAX_YEAR, LEDGER_MIN_YEAR } from './ledgerDateRange';
import { INCOME_STATEMENT_TYPES } from './trialBalanceBasis';

export function isIncomeStatementType(accountType: string): boolean {
  return (INCOME_STATEMENT_TYPES as readonly string[]).includes(accountType);
}

/** First day of the fiscal year containing `fromDate` for revenue/expense; null (no floor) otherwise. */
export function incomeStatementOpeningFloor(
  accountType: string,
  fromDate: string,
  fyStartMonth: number,
): string | null {
  return isIncomeStatementType(accountType) ? fiscalYearStart(fromDate, fyStartMonth) : null;
}

/** More boundaries than the legal year range can hold; a walk that reaches it is a bug. */
const MAX_BOUNDARIES = LEDGER_MAX_YEAR - LEDGER_MIN_YEAR + 2;

/**
 * Fiscal-year start dates strictly after `fromDate` and on or before `toDate`, ascending.
 * Both must be real 'YYYY-MM-DD' dates (ledgerDateRange): the walk compares strings, so an
 * odd one (a leading space sorts below every digit) used to never end. Bounded three ways:
 * validated input, integer years stepping down, and an iteration cap that throws.
 */
export function fiscalYearStartsWithin(fromDate: string, toDate: string, fyStartMonth: number): string[] {
  for (const d of [fromDate, toDate]) {
    if (!isLedgerDate(d)) throw new Error(`fiscalYearStartsWithin: invalid date '${String(d)}'`);
  }
  const out: string[] = [];
  let boundary = fiscalYearStart(toDate, fyStartMonth);
  let year = Number(boundary.slice(0, 4));
  while (boundary > fromDate) {
    if (out.length >= MAX_BOUNDARIES || !Number.isInteger(year)) {
      throw new Error('fiscalYearStartsWithin: fiscal-year walk did not terminate');
    }
    out.unshift(boundary);
    year -= 1;
    boundary = `${String(year).padStart(4, '0')}${boundary.slice(4)}`;
  }
  return out;
}

/** Last day of the fiscal year that ends immediately before `nextFyStart` ('YYYY-MM-01'). */
export function fiscalYearEndBefore(nextFyStart: string): string {
  const year = Number(nextFyStart.slice(0, 4));
  const month = Number(nextFyStart.slice(5, 7));
  const endYear = month === 1 ? year - 1 : year;
  const endMonth = month === 1 ? 12 : month - 1;
  // Date.UTC(y, m, 0) is the last day of 1-based month m — UTC, so no host-offset shift.
  const lastDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
  return `${String(endYear).padStart(4, '0')}-${String(endMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
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
