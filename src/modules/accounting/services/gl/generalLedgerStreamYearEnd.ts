/**
 * Fiscal-year basis for the general-ledger line stream (generalLedgerStreamService).
 *
 * Income-statement accounts restart at the fiscal-year start (trialBalanceBasis),
 * so the stream floors their opening balance at the start of the fiscal year
 * containing periodStart. The profit earned before that date leaves those
 * openings and re-enters, on an UNFILTERED read, as the TB's derived
 * Retained Earnings b/f key (`RE-BF`), so the opening set still nets to zero.
 *
 * NOT done here: a range that crosses a fiscal-year start does not reset an
 * income-statement account's running balance at the boundary. The stream is an
 * audit extract of posted lines with a count/universe contract, and a derived
 * close line would sit inside it. See gl/fiscalYearCloseRows for the listings
 * that do insert one.
 */

import { DEFAULT_FY_START_MONTH, fiscalYearStart, getFiscalYearStartMonth } from './fiscalYearBasis';
import { BROUGHT_FORWARD_CODE, getRetainedEarningsBroughtForward } from './trialBalanceBasis';

export interface StreamFiscalBasis {
  /** First day of the fiscal year containing periodStart — the income-statement opening floor. */
  fyStart: string;
  /** Retained earnings b/f (credit positive), or null when the read is filtered. */
  retainedBf: number | null;
}

export async function streamFiscalBasis(
  companyId: string,
  periodStart: string,
  unfiltered: boolean,
): Promise<StreamFiscalBasis> {
  // READ PATH: March fallback taken visibly, as the trial balance does.
  const month = await getFiscalYearStartMonth(companyId, { fallback: DEFAULT_FY_START_MONTH });
  const fyStart = fiscalYearStart(periodStart, month);
  const retainedBf = unfiltered ? await getRetainedEarningsBroughtForward(companyId, fyStart) : null;
  return { fyStart, retainedBf };
}

/** The opening set plus the derived RE-BF key when the read is unfiltered and it is non-zero. */
export function withRetainedBf(
  openingBalances: Record<string, number>,
  basis: StreamFiscalBasis,
): Record<string, number> {
  if (basis.retainedBf === null || Math.abs(basis.retainedBf) < 0.01) return openingBalances;
  return { ...openingBalances, [BROUGHT_FORWARD_CODE]: basis.retainedBf };
}
