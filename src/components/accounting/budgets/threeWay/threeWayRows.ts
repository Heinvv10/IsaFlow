/**
 * Rows for the three-way grids (budgets P6 spec §8): the budgeted balance sheet and the cash flow, straight from
 * the route's answer (`ThreeWayView`). Pure and arithmetic-free on the subtotals: every section and total is the
 * ENGINE's figure, never re-added here, so what the grid shows is what the engine checked (I1, I2, I3). Lines are
 * the buckets in the engine's own sectioning (`balanceSheet.ts`: VAT control is an asset when a debit, else a
 * liability). Money stays in CENTS; the grid formats.
 */
import type { ThreeWayView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';
import type { BalanceSheetSections, Buckets } from '@/modules/accounting/services/budgets/threeWay/types';

export type GridRowKind = 'section' | 'line' | 'subtotal' | 'total' | 'check';

export interface GridRow {
  key: string;
  label: string;
  kind: GridRowKind;
  /** One per column; null = blank (a section heading). Cents. */
  values: Array<number | null>;
}

export interface GridModel {
  columns: string[];
  rows: GridRow[];
}

type Col = { b: Buckets; s: BalanceSheetSections };

/** -0 (a negated zero balance) is 0. */
const z = (n: number): number => (n === 0 ? 0 : n);
const asset = (k: keyof Buckets) => (c: Col) => c.b[k];
const credit = (k: keyof Buckets) => (c: Col) => -c.b[k];

const BS_LAYOUT: Array<{ key: string; label: string; kind: GridRowKind; of?: (c: Col) => number }> = [
  { key: 'h-ca', label: 'Current assets', kind: 'section' },
  { key: 'cash', label: 'Cash and bank', kind: 'line', of: asset('cash') },
  { key: 'receivables', label: 'Trade receivables', kind: 'line', of: asset('receivables') },
  { key: 'inventory', label: 'Inventory', kind: 'line', of: asset('inventory') },
  { key: 'vatAsset', label: 'VAT receivable', kind: 'line', of: (c) => Math.max(c.b.vatControl, 0) },
  { key: 'otherCurrentAssets', label: 'Other current assets', kind: 'line', of: asset('otherCurrentAssets') },
  { key: 'currentAssets', label: 'Total current assets', kind: 'subtotal', of: (c) => c.s.currentAssets },
  { key: 'h-nca', label: 'Non-current assets', kind: 'section' },
  { key: 'fixedAssets', label: 'Property, plant and equipment', kind: 'line', of: asset('fixedAssets') },
  { key: 'accumDepreciation', label: 'Accumulated depreciation', kind: 'line', of: asset('accumDepreciation') },
  { key: 'otherNonCurrentAssets', label: 'Other non-current assets', kind: 'line', of: asset('otherNonCurrentAssets') },
  { key: 'nonCurrentAssets', label: 'Total non-current assets', kind: 'subtotal', of: (c) => c.s.nonCurrentAssets },
  { key: 'totalAssets', label: 'Total assets', kind: 'total', of: (c) => c.s.totalAssets },
  { key: 'h-cl', label: 'Current liabilities', kind: 'section' },
  { key: 'payables', label: 'Trade payables', kind: 'line', of: credit('payables') },
  { key: 'payrollLiabilities', label: 'Payroll liabilities', kind: 'line', of: credit('payrollLiabilities') },
  { key: 'incomeTaxPayable', label: 'Income tax payable', kind: 'line', of: credit('incomeTaxPayable') },
  { key: 'dividendsPayable', label: 'Dividends payable', kind: 'line', of: credit('dividendsPayable') },
  { key: 'vatLiability', label: 'VAT payable', kind: 'line', of: (c) => -Math.min(c.b.vatControl, 0) },
  { key: 'otherCurrentLiabilities', label: 'Other current liabilities', kind: 'line', of: credit('otherCurrentLiabilities') },
  { key: 'currentLiabilities', label: 'Total current liabilities', kind: 'subtotal', of: (c) => c.s.currentLiabilities },
  { key: 'h-ncl', label: 'Non-current liabilities', kind: 'section' },
  { key: 'loans', label: 'Loans', kind: 'line', of: credit('loans') },
  { key: 'otherNonCurrentLiabilities', label: 'Other non-current liabilities', kind: 'line', of: credit('otherNonCurrentLiabilities') },
  { key: 'nonCurrentLiabilities', label: 'Total non-current liabilities', kind: 'subtotal', of: (c) => c.s.nonCurrentLiabilities },
  { key: 'totalLiabilities', label: 'Total liabilities', kind: 'total', of: (c) => c.s.totalLiabilities },
  { key: 'h-eq', label: 'Equity', kind: 'section' },
  { key: 'shareCapital', label: 'Share capital', kind: 'line', of: credit('shareCapital') },
  { key: 'otherEquity', label: 'Other equity', kind: 'line', of: credit('otherEquity') },
  { key: 'retainedEarnings', label: 'Retained earnings', kind: 'line', of: credit('retainedEarnings') },
  { key: 'equity', label: 'Total equity', kind: 'total', of: (c) => c.s.equity },
  { key: 'check', label: 'Check (assets − liabilities − equity)', kind: 'check', of: (c) => c.s.check },
];

/** Opening, each month, FY close (= the last month's closing; the year end). */
export function balanceSheetModel(v: ThreeWayView): GridModel {
  const cols: Col[] = [
    { b: v.opening.buckets, s: v.opening.balanceSheet },
    ...v.balanceSheet.map((m) => ({ b: m.closing, s: m.sections })),
  ];
  const last = cols[cols.length - 1] as Col;
  const all = [...cols, last];
  return {
    columns: [`Opening ${v.opening.asAt}`, ...v.months, 'FY close'],
    rows: BS_LAYOUT.map((r) => ({ key: r.key, label: r.label, kind: r.kind, values: all.map((c) => (r.of ? z(r.of(c)) : null)) })),
  };
}

type Direct = ThreeWayView['cashFlow']['direct'][number];
type Indirect = ThreeWayView['cashFlow']['indirect'][number];
type FyMode = 'sum' | 'first' | 'last';

const CF_LAYOUT: Array<{ key: string; label: string; kind: GridRowKind; fy: FyMode; of?: (d: Direct) => number }> = [
  { key: 'openingCash', label: 'Opening cash', kind: 'line', fy: 'first', of: (d) => d.openingCash },
  { key: 'h-op', label: 'Operating activities', kind: 'section', fy: 'sum' },
  { key: 'customers', label: 'Cash received from customers', kind: 'line', fy: 'sum', of: (d) => d.direct.cash_received_from_customers },
  { key: 'suppliers', label: 'Cash paid to suppliers', kind: 'line', fy: 'sum', of: (d) => d.direct.cash_paid_to_suppliers },
  { key: 'employees', label: 'Cash paid to employees', kind: 'line', fy: 'sum', of: (d) => d.direct.cash_paid_to_employees },
  { key: 'otherOperating', label: 'Other operating (VAT, tax, interest)', kind: 'line', fy: 'sum', of: (d) => d.direct.other_operating },
  { key: 'operating', label: 'Net cash from operating activities', kind: 'subtotal', fy: 'sum', of: (d) => d.operating },
  { key: 'investing', label: 'Net cash from investing activities', kind: 'subtotal', fy: 'sum', of: (d) => d.investing },
  { key: 'financing', label: 'Net cash from financing activities', kind: 'subtotal', fy: 'sum', of: (d) => d.financing },
  { key: 'net', label: 'Net movement in cash', kind: 'total', fy: 'sum', of: (d) => d.net },
  { key: 'closingCash', label: 'Closing cash', kind: 'total', fy: 'last', of: (d) => d.closingCash },
];

const IND_LAYOUT: Array<{ key: keyof Indirect & string; label: string; kind: GridRowKind }> = [
  { key: 'netProfit', label: 'Net profit', kind: 'line' },
  { key: 'depreciation', label: 'Add back depreciation', kind: 'line' },
  { key: 'receivables', label: '(Increase) / decrease in receivables', kind: 'line' },
  { key: 'inventory', label: '(Increase) / decrease in inventory', kind: 'line' },
  { key: 'payables', label: 'Increase / (decrease) in payables', kind: 'line' },
  { key: 'payrollLiabilities', label: 'Increase / (decrease) in payroll liabilities', kind: 'line' },
  { key: 'vat', label: 'Movement in VAT (excluding capex VAT)', kind: 'line' },
  { key: 'incomeTax', label: 'Movement in income tax payable', kind: 'line' },
  { key: 'operating', label: 'Net cash from operating activities', kind: 'subtotal' },
];

/** A flow's FY figure: the flows' sum; opening cash the first month's, closing cash the last month's. */
function fyOf(values: number[], mode: FyMode): number {
  if (mode === 'first') return values[0] ?? 0;
  if (mode === 'last') return values[values.length - 1] ?? 0;
  return values.reduce((s, x) => s + x, 0);
}

export function cashFlowModel(v: ThreeWayView): GridModel {
  return {
    columns: [...v.months, 'FY'],
    rows: CF_LAYOUT.map((r) => {
      if (!r.of) return { key: r.key, label: r.label, kind: r.kind, values: [...v.months.map(() => null), null] };
      const vals = v.cashFlow.direct.map(r.of);
      return { key: r.key, label: r.label, kind: r.kind, values: [...vals, fyOf(vals, r.fy)] };
    }),
  };
}

/** The indirect reconciliation (§13: direct operating = indirect operating, I3). */
export function indirectModel(v: ThreeWayView): GridModel {
  return {
    columns: [...v.months, 'FY'],
    rows: IND_LAYOUT.map((r) => {
      const vals = v.cashFlow.indirect.map((m) => m[r.key] as number);
      return { key: `ind-${r.key}`, label: r.label, kind: r.kind, values: [...vals, fyOf(vals, 'sum')] };
    }),
  };
}
