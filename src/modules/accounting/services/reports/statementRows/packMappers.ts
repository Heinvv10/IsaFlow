/**
 * Report-pack section data → the shapes ManagementPandLRows and
 * ManagementBalanceSheetRows read. String keys with a `?? 0` fallback are
 * silent: a rename in reportPackService produces a plausible pack full of
 * zeros with no compile error, which is why these live here, importable by a
 * unit test, rather than inline in the page.
 */
import { incomeStatementPackRows, type PackPandLBand } from '../incomeStatementPackRows';
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

/**
 * Each band of the shared pack row list, keyed by its BAND KEY, never by its
 * display label. Keyed by label, rewording "Gross Profit" compiled clean and
 * silently demoted that band to `id: 'sub:Gross Margin'`, `kind: 'subtotal'` —
 * the reconciling totals would stop being marked as totals on a document sent
 * to a client. `Record<PackPandLBand, …>` also makes a NEW band a compile
 * error here rather than a row that quietly defaults.
 *
 * The reconciling subtotals are `total`, the bottom line is `grand`, every
 * band is a `subtotal`. `line` is reserved for accounts, which this surface
 * has none of.
 */
const PANDL_ROW: Record<PackPandLBand, { id: string; kind: StatementRow['kind']; label?: string }> = {
  revenue: { id: 'sub:revenue', kind: 'subtotal' },
  costOfSales: { id: 'sub:costOfSales', kind: 'subtotal' },
  grossProfit: { id: 'total:grossProfit', kind: 'total' },
  otherIncome: { id: 'sub:otherIncome', kind: 'subtotal' },
  operatingExpenses: { id: 'sub:operatingExpenses', kind: 'subtotal' },
  operatingProfit: { id: 'total:operatingProfit', kind: 'total' },
  otherExpenses: { id: 'sub:otherExpenses', kind: 'subtotal' },
  // The screen has always named the bottom line more fully than the packs do.
  netProfit: { id: 'grand:netProfit', kind: 'grand', label: 'Net Profit / (Loss)' },
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
  return incomeStatementPackRows(section).map(r => {
    const spec = PANDL_ROW[r.key];
    return {
      id: spec.id,
      kind: spec.kind,
      label: spec.label ?? r.label,
      depth: 0 as const,
      actual: r.amount,
    };
  });
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

/**
 * The management pack's balance-sheet summary rows — three subtotals plus the
 * derived Total Liabilities and Equity line (the report has no field for this;
 * same documented exception as balanceSheetRows.ts). `detail` copies the
 * report's own figures in, no arithmetic.
 *
 * Moved here from ManagementPandLRows.tsx so the printed pack and the PPTX
 * deck render the SAME rows the screen does rather than a second list.
 */
export function toManagementBsRows(
  bs: Record<string, number> | undefined,
  detail?: BalanceSheetDetail,
): StatementRow[] {
  const n = (k: string) => bs?.[k] ?? 0;
  return [
    { id: 'sub:totalAssets', kind: 'subtotal', label: 'Total Assets', depth: 0, actual: n('totalAssets') },
    ...(detail?.currentAssets !== undefined ? [{ id: 'line:currentAssets', kind: 'line' as const, label: 'Current Assets', depth: 1 as const, actual: detail.currentAssets }] : []),
    ...(detail?.cash !== undefined ? [{ id: 'line:cash', kind: 'line' as const, label: 'Cash', depth: 1 as const, actual: detail.cash }] : []),
    ...(detail?.accountsReceivable !== undefined ? [{ id: 'line:accountsReceivable', kind: 'line' as const, label: 'Accounts Receivable', depth: 1 as const, actual: detail.accountsReceivable }] : []),
    { id: 'sub:totalLiabilities', kind: 'subtotal', label: 'Total Liabilities', depth: 0, actual: n('totalLiabilities') },
    ...(detail?.accountsPayable !== undefined ? [{ id: 'line:accountsPayable', kind: 'line' as const, label: 'Accounts Payable', depth: 1 as const, actual: detail.accountsPayable }] : []),
    { id: 'sub:totalEquity', kind: 'subtotal', label: 'Total Equity', depth: 0, actual: n('totalEquity') },
    { id: 'grand:totalLiabilitiesAndEquity', kind: 'grand', label: 'Total Liabilities and Equity', depth: 0, actual: n('totalLiabilities') + n('totalEquity') },
  ];
}
