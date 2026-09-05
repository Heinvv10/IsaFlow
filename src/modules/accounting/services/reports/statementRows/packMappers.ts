/**
 * Report-pack section data → the shapes ManagementPandLRows and
 * ManagementBalanceSheetRows read. String keys with a `?? 0` fallback are
 * silent: a rename in reportPackService produces a plausible pack full of
 * zeros with no compile error, which is why these live here, importable by a
 * unit test, rather than inline in the page.
 */
import { incomeStatementPackRows } from '../incomeStatementPackRows';
import type { StatementRow } from './statementModel';

/**
 * The pack's balance-sheet detail figures. Declared here rather than in
 * `ManagementPandLRows.tsx`: it is a data shape, and a service-layer mapper
 * must not type-import from a component.
 */
export interface BalanceSheetDetail {
  currentAssets?: number;
  cash?: number;
  accountsReceivable?: number;
  accountsPayable?: number;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Which `StatementRow` kind each band of the shared pack row list is. The
 * reconciling subtotals are `total`, the bottom line is `grand`, every band is
 * a `subtotal`. `line` is reserved for accounts, which this surface has none
 * of. Keyed by the label `incomeStatementPackRows` emits. */
const PANDL_KIND: Record<string, StatementRow['kind']> = {
  'Gross Profit': 'total',
  'Operating Profit': 'total',
  'Net Profit': 'grand',
};

const PANDL_ID: Record<string, string> = {
  Turnover: 'sub:revenue',
  'Cost of Sales': 'sub:costOfSales',
  'Gross Profit': 'total:grossProfit',
  'Other Income': 'sub:otherIncome',
  'Operating Expenses': 'sub:operatingExpenses',
  'Operating Profit': 'total:operatingProfit',
  'Other Expenses': 'sub:otherExpenses',
  'Net Profit': 'grand:netProfit',
};

/**
 * The management pack's P&L rows, built from the SAME band list the HTML and
 * PDF packs render: `incomeStatementPackRows`. There were two lists reading
 * the same section blob and duplicating the omit-when-zero rule, and two
 * copies of a band list is two chances to omit a band — which is exactly how
 * the pack came to be short by `otherIncome - otherExpenses` (R341,712.00 on
 * Brightsphere) on documents sent to clients.
 *
 * The input is the totals shape (`totalRevenue`, …) because that is what both
 * pack surfaces already hold; it is translated back to the section keys the
 * shared builder reads.
 */
export function toManagementPandLRows(totals: Record<string, number> | undefined): StatementRow[] {
  const n = (k: string) => totals?.[k] ?? 0;
  const section = {
    revenue: n('totalRevenue'), costOfSales: n('totalCostOfSales'), grossProfit: n('grossProfit'),
    otherIncome: n('totalOtherIncome'), operatingExpenses: n('totalOperatingExpenses'),
    operatingProfit: n('operatingProfit'), otherExpenses: n('totalOtherExpenses'), netProfit: n('netProfit'),
  };
  return incomeStatementPackRows(section).map(r => ({
    id: PANDL_ID[r.label] ?? `sub:${r.label}`,
    kind: PANDL_KIND[r.label] ?? 'subtotal',
    label: r.label === 'Net Profit' ? 'Net Profit / (Loss)' : r.label,
    depth: 0 as const,
    actual: r.amount,
  }));
}

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
