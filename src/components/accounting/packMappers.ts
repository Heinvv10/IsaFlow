/**
 * Report-pack section data → the shapes ManagementPandLRows and
 * ManagementBalanceSheetRows read. String keys with a `?? 0` fallback are
 * silent: a rename in reportPackService produces a plausible pack full of
 * zeros with no compile error, which is why these live here, importable by a
 * unit test, rather than inline in the page.
 */
import type { BalanceSheetDetail } from '@/components/accounting/ManagementPandLRows';

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The pack's `income_statement` section keys → the P&L totals shape. */
export function packToTotals(d: Record<string, unknown>): Record<string, number> {
  return {
    totalRevenue: num(d.revenue), totalCostOfSales: num(d.costOfSales), grossProfit: num(d.grossProfit),
    totalOtherIncome: num(d.otherIncome), totalOperatingExpenses: num(d.operatingExpenses),
    operatingProfit: num(d.operatingProfit), totalOtherExpenses: num(d.otherExpenses), netProfit: num(d.netProfit),
  };
}

/** The pack's two margin figures. The service computes them; the pack lost
 * them when it moved onto StatementGrid, and they are the figures a reader
 * quotes back. */
export function packToMargins(d: Record<string, unknown>): { grossMargin: number; netMargin: number } {
  return { grossMargin: num(d.grossMargin), netMargin: num(d.netMargin) };
}

/** The pack's `balance_sheet` section keys → the balance-sheet totals shape.
 * Typed, so a non-numeric value cannot reach the grid and be concatenated. */
export function packToBsTotals(d: Record<string, unknown>): Record<string, number> {
  return {
    totalAssets: num(d.totalAssets), totalLiabilities: num(d.totalLiabilities), totalEquity: num(d.totalEquity),
  };
}

/** The pack's balance_sheet detail figures, copied straight through. */
export function packToBsDetail(d: Record<string, unknown>): BalanceSheetDetail {
  return {
    currentAssets: num(d.currentAssets), cash: num(d.cash),
    accountsReceivable: num(d.accountsReceivable), accountsPayable: num(d.accountsPayable),
  };
}
