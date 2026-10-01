/**
 * The figures behind the board / management / monthly PDF pack.
 *
 * Assembled here rather than in the route handler, which is why the previous
 * version had no tests and carried four literals:
 *
 *     cash: 0,
 *     accountsReceivable: 0,
 *     accountsPayable: 0,
 *     inventory: 0,
 *
 * Every liquidity figure a director read off that pack — current ratio, quick
 * ratio, cash position — was therefore computed from zero regardless of what
 * the company held.
 *
 * The two figures that WERE computed came from account-code ranges:
 *
 *     accountCode.startsWith('1') && Number(accountCode) < 1200
 *     accountCode.startsWith('2') && Number(accountCode) < 2200
 *
 * Production charts put assets, liabilities, equity, revenue and expenses all
 * under code prefix '4', and Sage-imported charts use alphabetic prefixes, so
 * on a real chart those filters select close to nothing. Nothing here may look
 * at account_code — see the header of gl/accountSubtypes.
 *
 * Everything now comes from `getFinancialFigures`, the one resolver that
 * classifies on `account_type` plus canonical subtypes, and whose `totalEquity`
 * carries the accumulated result so the accounting equation closes.
 */

import {
  getFinancialFigures,
  toFinancialData,
  inventoryWarning,
  unclassifiedWarning,
} from '@/modules/accounting/services/gl/financialFiguresService';
import { log } from '@/lib/logger';
import { withSavepoint } from '@/lib/neon';
import { isFailedRead } from '@/modules/accounting/services/packs/packFailedRead';
import { getCashFlowDirect } from '@/modules/accounting/services/afs/cashFlowDirectService';
import { round2 } from '@/modules/accounting/services/reconciliation/reconciliationMath';
import type { ReportPackInput } from './reportPackService';

export interface ReportPackFigures extends ReportPackInput {
  /**
   * Set when the chart of accounts classifies no inventory at all, so
   * `inventory` is zero because nothing could be identified rather than
   * because there is none. A quick ratio built on it has not actually
   * excluded inventory.
   */
  inventoryCaveat: string | null;
  /**
   * Set when subtypes were NULL or unrecognised and the resolver defaulted
   * them to current — so the current-asset and current-liability splits are
   * partly a default rather than a statement of fact.
   */
  classificationCaveat: string | null;
  /**
   * The period's depreciation and amortisation charge, from the classifier's
   * `depreciation_expense` band (which `accountSubtypes` maps both words onto).
   *
   * Carried so EBITDA is a MEASURE rather than a label. `calculateExtendedRatios`
   * computes `ebitda = ebit + depreciation + amortisation`, and this field was
   * never supplied — so the board pack printed a row headed EBITDA whose value
   * was the operating line to the rand, undefined and unreconciled, on a page
   * where an audit committee chair asks about it first. Required, not optional:
   * a defaulted zero is indistinguishable from a company that genuinely charges
   * none, and page 12's reconciliation prints the add-back either way.
   */
  depreciation: number;
}

type PackCashFlows = Pick<
  ReportPackFigures,
  'operatingCashFlow' | 'investingCashFlow' | 'financingCashFlow'
>;

/**
 * THE WINDOW'S CASH FLOWS, FROM THE ONE SERVICE THAT COMPUTES THEM OFF THE
 * LEDGER.
 *
 * Nothing populated these, so page 8 of the board pack printed three "n/m"
 * rows on every tenant. `getCashFlowDirect` distributes every posted cash leg
 * in the window once across its contra accounts, over the same cash accounts
 * `figures.cumulative.cash` sums — so opening cash plus these three is closing
 * cash.
 *
 * A STATEMENT THE DATABASE REFUSES IS CARRIED AS ABSENT, the way an unreadable
 * comparative is (`packFigureSet.fetchPrior`): the three fields stay unset,
 * page 8 prints "n/m" with its reason, and the sheets that do not depend on
 * them still print. In its own savepoint, because a caught failure otherwise
 * leaves the request's transaction aborted; and only a failed READ is absent
 * — a defect in the statement is re-thrown. See `packFailedRead`.
 */
async function readCashFlows(companyId: string, from: string, to: string): Promise<PackCashFlows> {
  let cashFlow: Awaited<ReturnType<typeof getCashFlowDirect>>;
  try {
    cashFlow = await withSavepoint('pack_cash_flows', () => getCashFlowDirect(companyId, from, to));
  } catch (error) {
    if (!isFailedRead(error)) throw error;
    log.warn(
      'getReportPackInput: the cash flow statement could not be read, cash flow figures omitted',
      { companyId, from, to, error: error instanceof Error ? error.name : typeof error },
      'packs',
    );
    return {};
  }
  // TO THE CENT, AND STILL FOOTING. The service apportions by division, so
  // its totals carry float dust, and three figures rounded apart can miss
  // their own rounded sum by a cent — which page 8 would have to print as a
  // movement nobody explained. Investing and financing are rounded; operating
  // takes what is left of the rounded movement, at most a cent from its own
  // rounding.
  const investingCashFlow = round2(cashFlow.investingTotal);
  const financingCashFlow = round2(cashFlow.financingTotal);
  const operatingCashFlow = round2(round2(cashFlow.netChange) - investingCashFlow - financingCashFlow);
  return { operatingCashFlow, investingCashFlow, financingCashFlow };
}

export async function getReportPackInput(
  companyId: string,
  companyName: string,
  from: string,
  to: string,
): Promise<ReportPackFigures> {
  const figures = await getFinancialFigures(companyId, from, to);
  const data = toFinancialData(figures);

  const cashFlows = await readCashFlows(companyId, from, to);

  const inventory = inventoryWarning(figures);
  const unclassified = unclassifiedWarning(figures.cumulative);

  return {
    companyName,
    period: `${from} to ${to}`,
    revenue: data.revenue,
    costOfSales: data.costOfSales,
    operatingExpenses: data.operatingExpenses,
    // Carried so the pack's P&L FOOTS and its waterfall shows the steps it
    // already supports. Omitted, `ReportPackInput`'s optional fields defaulted
    // to 0 and `buildProfitWaterfall` gated both steps on `!== 0`, so a pack's
    // Other Income and Other Expenses were ALWAYS suppressed and its Net Profit
    // subtotal hung off the running total by their net — R341,712.00 on
    // Brightsphere, on a customer-facing PDF.
    otherIncome: data.otherIncome,
    otherExpenses: figures.period.otherExpenses,
    // No `?? 0` here: both fields are required `number` on `ClassifiedFigures`
    // and `toFinancialData` passes them straight through, so the nullish branch
    // was dead. (An earlier comment claimed it was defeating `operatingProfitOf`'s
    // fallback — it could never be reached. Recorded because that commit's own
    // thesis was that a doc must not overclaim.)
    operatingProfit: data.operatingProfit,
    netProfit: data.netProfit,
    totalAssets: data.totalAssets,
    totalLiabilities: data.totalLiabilities,
    totalEquity: data.totalEquity,
    currentAssets: data.currentAssets,
    currentLiabilities: data.currentLiabilities,
    cash: data.cash,
    accountsReceivable: data.accountsReceivable,
    accountsPayable: data.accountsPayable,
    inventory: data.inventory,
    ...cashFlows,
    // `.board`, NOT `.message`: these two strings reach a board pack's basis
    // page, and the operator wording names a database column and tells the
    // reader to go and set it. See `FigureCaveat`.
    depreciation: figures.period.depreciation,
    inventoryCaveat: inventory === null ? null : inventory.board,
    classificationCaveat: unclassified === null ? null : unclassified.board,
  };
}
