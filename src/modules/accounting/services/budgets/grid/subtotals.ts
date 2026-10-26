/**
 * Live band subtotals and GP / OP / NP for the budget grid, per month and FY,
 * in integer cents. The definitions are `aggregateFigures`' (gl/accountClassification):
 * other income sits BELOW gross profit and ABOVE operating profit. A parity test
 * holds the two together. Band order is incomeStatementRows' reconciling order.
 *
 * Amounts are natural sign: revenue and income positive, expenses positive.
 */
import { expenseBand, revenueBand } from '@/modules/accounting/services/gl/accountClassification';

export type Band = 'turnover' | 'cost_of_sales' | 'other_income' | 'operating_expense' | 'other_expense';

export const BAND_ORDER: readonly Band[] = ['turnover', 'cost_of_sales', 'other_income', 'operating_expense', 'other_expense'];

export const BAND_LABEL: Readonly<Record<Band, string>> = {
  turnover: 'Turnover',
  cost_of_sales: 'Cost of Sales',
  other_income: 'Other Income',
  operating_expense: 'Operating Expenses',
  other_expense: 'Other Expenses',
};

/** Income bands add to profit; expense bands subtract. */
export const BAND_SIGN: Readonly<Record<Band, 1 | -1>> = {
  turnover: 1, cost_of_sales: -1, other_income: 1, operating_expense: -1, other_expense: -1,
};

export type Metric =
  | 'turnover' | 'costOfSales' | 'grossProfit' | 'otherIncome'
  | 'operatingExpenses' | 'operatingProfit' | 'otherExpenses' | 'netProfit';

export type BandSums = Record<Band, number[]>;

export interface BandTotals {
  months: Record<Metric, number[]>;
  fy: Record<Metric, number>;
}

/** The grid's band for a revenue or expense account, by subtype (the statement's rule). */
export function bandOf(type: 'revenue' | 'expense', subtype: string | null | undefined): Band {
  return type === 'revenue' ? revenueBand(subtype) : expenseBand(subtype);
}

export function emptyBandSums(monthCount: number): BandSums {
  const z = () => Array<number>(monthCount).fill(0);
  return { turnover: z(), cost_of_sales: z(), other_income: z(), operating_expense: z(), other_expense: z() };
}

export function bandSums<R extends { band: Band }>(
  rows: readonly R[], valueOf: (row: R) => readonly (number | null)[], monthCount: number,
): BandSums {
  const sums = emptyBandSums(monthCount);
  for (const row of rows) {
    const target = sums[row.band];
    const values = valueOf(row);
    for (let m = 0; m < monthCount; m++) target[m] = (target[m] ?? 0) + (values[m] ?? 0);
  }
  return sums;
}

export function deriveTotals(s: BandSums, monthCount: number): BandTotals {
  const at = (f: (m: number) => number) => Array.from({ length: monthCount }, (_, m) => f(m));
  const v = (xs: readonly number[], m: number): number => xs[m] ?? 0;
  const grossProfit = at(m => v(s.turnover, m) - v(s.cost_of_sales, m));
  const operatingProfit = at(m => v(grossProfit, m) + v(s.other_income, m) - v(s.operating_expense, m));
  const netProfit = at(m => v(operatingProfit, m) - v(s.other_expense, m));
  const months: Record<Metric, number[]> = {
    turnover: [...s.turnover], costOfSales: [...s.cost_of_sales], grossProfit,
    otherIncome: [...s.other_income], operatingExpenses: [...s.operating_expense], operatingProfit,
    otherExpenses: [...s.other_expense], netProfit,
  };
  const fy = Object.fromEntries(
    Object.entries(months).map(([k, v]) => [k, v.reduce((a, b) => a + b, 0)]),
  ) as Record<Metric, number>;
  return { months, fy };
}

export function foldBands<R extends { band: Band }>(
  rows: readonly R[], valueOf: (row: R) => readonly (number | null)[], monthCount: number,
): BandTotals {
  return deriveTotals(bandSums(rows, valueOf, monthCount), monthCount);
}
