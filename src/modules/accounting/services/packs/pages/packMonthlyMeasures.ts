/**
 * Page 5's measure columns — which `PackTrendPoint` field each one reads, the
 * band it sits in — and the label of the window the closing row sums. Split
 * out of `packMonthlyResults.ts` for the 300-line cap: the table and the
 * page's sentences both read them, so they are a leaf neither owns.
 */
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import { monthLabel } from './packPartialMonth';
import type { PackTableColumnKey } from './packPageModel';

/** The five measure columns, in the order they print. */
export const COLUMNS: readonly PackTableColumnKey[] = [
  'revenue',
  'otherIncome',
  'costOfSales',
  'monthOperatingExpenses',
  'otherExpenses',
  'netProfit',
] as const;

/** The below-the-operating-line band of a month's expenses.
 *
 *  Derived by DIFFERENCE, not fetched: `getPackTrend` computes
 *  `operatingExpenses = expenses − costOfSales − belowOperatingLine` and
 *  rounds it, so the difference taken back out is the only figure that makes
 *  the printed row add up. A second read of the band would round separately
 *  and put a cent between the four columns and the fifth. */
function otherExpensesOf(point: PackTrendPoint): number {
  return point.expenses - point.costOfSales - point.operatingExpenses;
}

/**
 * THE BAND A MEASURE SITS IN, which is what decides whether its sign is
 * ordinary or the thing to say out loud.
 *
 * An income column is a credit band and an expense column a debit band, so a
 * NEGATIVE figure in either is contrary to the band: more was reversed out of
 * those accounts than posted into them. `netProfit` is neither — a loss is an
 * ordinary result, not an anomaly — and carries no reading.
 */
type MeasureBand = 'income' | 'expense' | 'result';

export const MEASURES: ReadonlyArray<{
  column: PackTableColumnKey;
  field: string;
  read: (p: PackTrendPoint) => number;
  band: MeasureBand;
  /** The measure's name in a SENTENCE. Two of the column headings are
   *  abbreviated because `TABLE_HEAD_MM` budgets one line for a 7pt caps
   *  heading over a 26mm measure ("Operating", "Other"), and a caption that
   *  used those would name half a measure. The page's own "The columns" note
   *  glosses both, so a reader given the full name finds the column. */
  prose: string;
}> = [
  { column: 'revenue', field: 'revenue', read: (p) => p.revenue, band: 'income', prose: 'revenue' },
  { column: 'otherIncome', field: 'otherIncome', read: (p) => p.otherIncome, band: 'income', prose: 'other income' },
  { column: 'costOfSales', field: 'costOfSales', read: (p) => p.costOfSales, band: 'expense', prose: 'cost of sales' },
  { column: 'monthOperatingExpenses', field: 'operatingExpenses', read: (p) => p.operatingExpenses, band: 'expense', prose: 'operating expenses' },
  { column: 'otherExpenses', field: 'otherExpenses', read: otherExpensesOf, band: 'expense', prose: 'other expenses' },
  { column: 'netProfit', field: 'netProfit', read: (p) => p.netProfit, band: 'result', prose: 'net profit' },
];

/** What the closing row is called — its own window, never "Total". See the
 *  header: the pack's period is a different window and prints its own totals
 *  on the next sheet. */
export function trendWindowLabel(trend: PackTrendPoint[]): string {
  const last = trend[trend.length - 1]!;
  const months = trend.length === 1 ? '1 month' : `${trend.length} months`;
  // THE STUB IS MARKED IN THE TOTAL ROW'S OWN LABEL, because the total row is
  // where a reader who never reaches the last month meets the window: it sums
  // eleven whole months and seven days of a twelfth, and "12 months to Sep
  // 2026" says otherwise. See `packPartialMonth.ts`.
  return `${months} to ${monthLabel(last)}`;
}
