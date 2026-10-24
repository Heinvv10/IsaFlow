/**
 * Fiscal-year basis for the general-ledger line stream (generalLedgerStreamService).
 *
 * Income-statement accounts restart at the fiscal-year start (trialBalanceBasis),
 * so the stream floors their opening balance at the start of the fiscal year
 * containing periodStart. The profit earned before that date drops out of those
 * openings. On an UNFILTERED read it is returned as the trial balance's derived
 * Retained Earnings b/f key (`RE-BF`, credit positive), omitted when under 1 cent.
 * Each value in the set is signed to its own account's normal side, so the set
 * does not sum to zero; what holds is that the debit-normal openings equal the
 * credit-normal openings plus `RE-BF`, i.e. the opening trial balance foots.
 * A filtered read gets no `RE-BF` (the retained earnings of a subset is meaningless).
 *
 * NOT done here: a derived close line. The stream is an audit extract of posted
 * lines with a count/universe contract, and one would sit inside it. So when the
 * range crosses a fiscal-year start, an income-statement line dated on or after
 * that start has `runningBalance` null (a cumulative total would not be the
 * trial balance's), and the page says where in `incomeStatementBalanceNullFrom`.
 * See gl/fiscalYearCloseRows for the listings that do insert a close line.
 */

import { dayAfter, isIncomeStatementType } from './fiscalYearCloseRows';
import { fiscalYearForDate } from './fiscalYearRegistry';
import { assertLedgerRange } from './ledgerDateRange';
import { BROUGHT_FORWARD_CODE, getRetainedEarningsBroughtForward } from './trialBalanceBasis';

export interface StreamFiscalBasis {
  /** First day of the fiscal year containing periodStart — the income-statement opening floor. */
  fyStart: string;
  /** First day of the fiscal year after it (the day after the year ends). */
  nextFyStart: string;
  /** Retained earnings b/f (credit positive), or null when the read is filtered. */
  retainedBf: number | null;
}

/**
 * Reads the registry year holding periodStart, and on an unfiltered read the RE-BF balance: up to TWO extra
 * statements per stream page, each a separate statement from the line/opening query.
 *
 * CONSISTENCY WINDOW: under READ COMMITTED (the request transaction's level) each statement sees
 * its own snapshot, so a posting that commits between the opening query and the RE-BF read can make
 * the returned opening set (with RE-BF) fail to foot by that posting. It is not folded into the
 * main query because RE-BF comes from getRetainedEarningsBroughtForward (trialBalanceBasis), shared
 * with the trial balance, whose account-type logic would have to be duplicated into this SQL. A
 * caller needing a guaranteed foot runs the stream in a REPEATABLE READ transaction, as the stream's
 * integration test does (R-165).
 */
export async function streamFiscalBasis(
  companyId: string,
  periodStart: string,
  unfiltered: boolean,
  periodEnd: string,
): Promise<StreamFiscalBasis> {
  assertLedgerRange(periodStart, periodEnd);
  const year = await fiscalYearForDate(companyId, periodStart);
  const fyStart = year.startDate;
  const retainedBf = unfiltered ? await getRetainedEarningsBroughtForward(companyId, fyStart) : null;
  return { fyStart, nextFyStart: dayAfter(year.endDate), retainedBf };
}

/** The opening set plus the derived RE-BF key when the read is unfiltered and it is non-zero. */
export function withRetainedBf(
  openingBalances: Record<string, number>,
  basis: StreamFiscalBasis,
): Record<string, number> {
  if (basis.retainedBf === null || Math.abs(basis.retainedBf) < 0.01) return openingBalances;
  return { ...openingBalances, [BROUGHT_FORWARD_CODE]: basis.retainedBf };
}

/**
 * The next fiscal-year start (`nextFyStart`) when the range reaches it, else null. From that
 * date an income-statement account's cumulative running balance no longer equals its
 * balance (the TB restarts it), and the stream inserts no close line, so it is withheld.
 */
export function incomeStatementBalanceNullFrom(nextFyStart: string, periodEnd: string): string | null {
  return periodEnd >= nextFyStart ? nextFyStart : null;
}

/** False for an income-statement line on or after `nullFrom`; true otherwise. */
export function runningBalanceIsDefined(accountType: string, date: string, nullFrom: string | null): boolean {
  return nullFrom === null || date < nullFrom || !isIncomeStatementType(accountType);
}
