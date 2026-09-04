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
    otherIncome: data.otherIncome ?? 0,
    otherExpenses: figures.period.otherExpenses,
    operatingProfit: data.operatingProfit ?? 0,
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
    inventoryCaveat: inventory === null ? null : inventory.message,
    classificationCaveat: unclassified === null ? null : unclassified.message,
  };
}
