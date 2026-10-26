/**
 * Live subtotals: bands in the income statement's reconciling order, GP / OP /
 * NP per month and FY, and PARITY with `aggregateFigures` (the one definition
 * every report uses) on the same fixture.
 */
import { describe, it, expect } from 'vitest';
import {
  BAND_ORDER, type Band, bandOf, deriveTotals, foldBands, bandSums,
} from '@/modules/accounting/services/budgets/grid/subtotals';
import { aggregateFigures, type ClassificationRow } from '@/modules/accounting/services/gl/accountClassification';

interface Acc { type: 'revenue' | 'expense'; subtype: string | null; months: (number | null)[] }

const ACCOUNTS: Acc[] = [
  { type: 'revenue', subtype: 'operating_revenue', months: [1000000, 1200000, null] },
  { type: 'revenue', subtype: null, months: [50000, 0, 70000] },
  { type: 'revenue', subtype: 'other_income', months: [30000, 30000, 30000] },
  { type: 'expense', subtype: 'cost_of_sales', months: [400000, 450000, 500000] },
  { type: 'expense', subtype: 'operating_expense', months: [200000, -10000, 210000] },
  { type: 'expense', subtype: 'depreciation_expense', months: [15000, 15000, 15000] },
  { type: 'expense', subtype: null, months: [5000, 5000, null] },
  { type: 'expense', subtype: 'finance_cost', months: [12000, 12000, 12000] },
  { type: 'expense', subtype: 'tax_expense', months: [90000, 0, 0] },
];
const rows = ACCOUNTS.map(a => ({ ...a, band: bandOf(a.type, a.subtype) }));
const valueOf = (r: Acc) => r.months;

function classificationRows(month: number | null): ClassificationRow[] {
  return ACCOUNTS.map(a => {
    const cents = month === null ? a.months.reduce<number>((s, m) => s + (m ?? 0), 0) : (a.months[month] ?? 0);
    const amount = cents / 100;
    const natural = { debit: Math.max(amount, 0), credit: Math.max(-amount, 0) };
    return {
      account_type: a.type, account_subtype: a.subtype,
      ...(a.type === 'expense' ? natural : { debit: natural.credit, credit: natural.debit }),
    };
  });
}

describe('bandOf', () => {
  it.each([
    ['revenue', 'operating_revenue', 'turnover'],
    ['revenue', null, 'turnover'],
    ['revenue', 'other_income', 'other_income'],
    ['expense', 'cost_of_sales', 'cost_of_sales'],
    ['expense', null, 'operating_expense'],
    ['expense', 'finance_cost', 'other_expense'],
    ['expense', 'tax_expense', 'other_expense'],
  ] as const)('%s / %s → %s', (type, subtype, band) => {
    expect(bandOf(type, subtype)).toBe(band);
  });

  it('BAND_ORDER is the reconciling order', () => {
    expect(BAND_ORDER).toEqual<Band[]>(['turnover', 'cost_of_sales', 'other_income', 'operating_expense', 'other_expense']);
  });
});

describe('foldBands', () => {
  const t = foldBands(rows, valueOf, 3);

  it('GP = turnover − cost of sales (other income is BELOW gross profit)', () => {
    expect(t.months.grossProfit).toEqual([1050000 - 400000, 1200000 - 450000, 70000 - 500000]);
  });

  it('OP = GP + other income − operating expenses; NP = OP − other expenses', () => {
    expect(t.months.operatingProfit).toEqual([650000 + 30000 - 220000, 750000 + 30000 - 10000, -430000 + 30000 - 225000]);
    expect(t.months.netProfit).toEqual([460000 - 102000, 770000 - 12000, -625000 - 12000]);
  });

  it('FY is the sum of the months for every metric', () => {
    for (const [metric, months] of Object.entries(t.months)) {
      expect(t.fy[metric as keyof typeof t.fy]).toBe(months.reduce((s, m) => s + m, 0));
    }
  });

  it.each([0, 1, 2, null])('parity with aggregateFigures (month %s)', month => {
    const f = aggregateFigures(classificationRows(month));
    const pick = (m: keyof typeof t.fy) => (month === null ? t.fy[m] : t.months[m][month]) / 100;
    expect(pick('turnover')).toBeCloseTo(f.revenue, 2);
    expect(pick('costOfSales')).toBeCloseTo(f.costOfSales, 2);
    expect(pick('grossProfit')).toBeCloseTo(f.grossProfit, 2);
    expect(pick('otherIncome')).toBeCloseTo(f.otherIncome, 2);
    expect(pick('operatingExpenses')).toBeCloseTo(f.operatingExpenses, 2);
    expect(pick('operatingProfit')).toBeCloseTo(f.operatingProfit, 2);
    expect(pick('otherExpenses')).toBeCloseTo(f.otherExpenses, 2);
    expect(pick('netProfit')).toBeCloseTo(f.netProfit, 2);
  });

  it('deriveTotals over incrementally kept band sums equals a full fold', () => {
    expect(deriveTotals(bandSums(rows, valueOf, 3), 3)).toEqual(t);
  });

  it('an empty grid is all zeros', () => {
    expect(foldBands([], valueOf, 2).months.netProfit).toEqual([0, 0]);
  });
});
