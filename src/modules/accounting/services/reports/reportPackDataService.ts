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

export async function getReportPackInput(
  companyId: string,
  companyName: string,
  from: string,
  to: string,
): Promise<ReportPackFigures> {
  const figures = await getFinancialFigures(companyId, from, to);
  const data = toFinancialData(figures);

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
    // `.board`, NOT `.message`: these two strings reach a board pack's basis
    // page, and the operator wording names a database column and tells the
    // reader to go and set it. See `FigureCaveat`.
    depreciation: figures.period.depreciation,
    inventoryCaveat: inventory === null ? null : inventory.board,
    classificationCaveat: unclassified === null ? null : unclassified.board,
  };
}
