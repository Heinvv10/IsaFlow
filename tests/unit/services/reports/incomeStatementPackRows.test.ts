/**
 * The row list both client-facing packs render.
 *
 * The HTML and PDF packs had a list each, both short by `otherIncome -
 * otherExpenses` — R341,712.00 on Brightsphere — and neither was testable:
 * `renderSectionHtml` is not exported and `renderSection` takes a jsPDF
 * document. Deleting a row from either left the whole suite green.
 */

import { describe, it, expect } from 'vitest';
import { incomeStatementPackRows } from '@/modules/accounting/services/reports/incomeStatementPackRows';

/** Brightsphere, all-time. */
const BRIGHTSPHERE = {
  revenue: 13485163.41, costOfSales: 0, grossProfit: 13485163.41,
  otherIncome: 23323.42, operatingExpenses: 4748602.81,
  operatingProfit: 8759884.02, otherExpenses: 365035.42,
  netProfit: 8394848.60, grossMargin: 100, netMargin: 62.25,
};

const by = (rows: ReturnType<typeof incomeStatementPackRows>, label: string) =>
  rows.find(r => r.label === label);

describe('incomeStatementPackRows', () => {
  it('emits every band', () => {
    const labels = incomeStatementPackRows(BRIGHTSPHERE).map(r => r.label);
    expect(labels).toEqual([
      'Turnover', 'Cost of Sales', 'Gross Profit', 'Other Income',
      'Operating Expenses', 'Operating Profit', 'Other Expenses', 'Net Profit',
    ]);
  });

  it('FOOTS: the reader can get from gross profit to net profit', () => {
    const r = incomeStatementPackRows(BRIGHTSPHERE);
    const v = (l: string) => by(r, l)!.amount;
    expect(v('Gross Profit') + v('Other Income') - v('Operating Expenses'))
      .toBeCloseTo(v('Operating Profit'), 2);
    expect(v('Operating Profit') - v('Other Expenses')).toBeCloseTo(v('Net Profit'), 2);
    // Without the two bands the pack was short by exactly this.
    expect(v('Turnover') - v('Cost of Sales') - v('Operating Expenses'))
      .not.toBeCloseTo(v('Net Profit'), 2);
    expect(Math.abs(
      (v('Turnover') - v('Cost of Sales') - v('Operating Expenses')) - v('Net Profit'),
    )).toBeCloseTo(341712.00, 2);
  });

  it('puts Other Income ABOVE the Operating Profit that contains it', () => {
    const labels = incomeStatementPackRows(BRIGHTSPHERE).map(r => r.label);
    expect(labels.indexOf('Other Income')).toBeGreaterThan(-1);
    expect(labels.indexOf('Other Income')).toBeLessThan(labels.indexOf('Operating Expenses'));
    expect(labels.indexOf('Operating Profit')).toBeGreaterThan(labels.indexOf('Other Income'));
    expect(labels.indexOf('Other Expenses')).toBeGreaterThan(labels.indexOf('Operating Profit'));
  });

  it('omits a nil band but never the Operating Profit subtotal', () => {
    const labels = incomeStatementPackRows({
      ...BRIGHTSPHERE, otherIncome: 0, otherExpenses: 0,
    }).map(r => r.label);
    expect(labels).not.toContain('Other Income');
    expect(labels).not.toContain('Other Expenses');
    expect(labels).toContain('Operating Profit');
  });

  it('derives the operating line when a caller supplies none', () => {
    const { operatingProfit: _drop, ...rest } = BRIGHTSPHERE;
    expect(by(incomeStatementPackRows(rest), 'Operating Profit')!.amount)
      .toBeCloseTo(8759884.02, 2);
  });

  it('renders a negative band rather than hiding it', () => {
    const r = incomeStatementPackRows({ ...BRIGHTSPHERE, otherIncome: -5000 });
    expect(by(r, 'Other Income')!.amount).toBeCloseTo(-5000, 2);
  });

  it('carries the margins onto the two rows that show them', () => {
    const r = incomeStatementPackRows(BRIGHTSPHERE);
    // NUMBER, not a string carrying one: as a string each pack coerced it
    // differently, so typing it properly at source would have made one pack
    // print NaN% while the other kept working.
    expect(by(r, 'Gross Profit')!.margin).toBe(100);
    expect(by(r, 'Net Profit')!.margin).toBe(62.25);
    expect(by(r, 'Operating Expenses')!.margin).toBeUndefined();
  });

  it('survives a section payload with missing or non-numeric fields', () => {
    const r = incomeStatementPackRows({ revenue: 'x', netProfit: null });
    expect(r.every(x => Number.isFinite(x.amount))).toBe(true);
  });
});

/**
 * Three margin states, not two. The legacy HTML and PDF packs read this
 * builder's `margin` field directly, and coercing a null margin to 0 here is
 * what printed "Gross margin 0.0%" on a period whose turnover was negative.
 */
describe('incomeStatementPackRows — margin states', () => {
  it('carries a null margin through as null, never 0', () => {
    const r = incomeStatementPackRows({
      revenue: -1000, costOfSales: 0, grossProfit: -1000, operatingExpenses: 500,
      netProfit: -1500, grossMargin: null, netMargin: null,
    });
    expect(by(r, 'Gross Profit')!.margin).toBeNull();
    expect(by(r, 'Net Profit')!.margin).toBeNull();
  });

  it('treats an absent margin key as "none to print", not as zero', () => {
    const r = incomeStatementPackRows({ revenue: 100, netProfit: 10 });
    expect(by(r, 'Gross Profit')!.margin).toBeNull();
    expect(by(r, 'Net Profit')!.margin).toBeNull();
  });

  it('keeps undefined for a band that never carries a margin', () => {
    const r = incomeStatementPackRows({ revenue: 100, grossMargin: 40, netMargin: 10, netProfit: 10 });
    expect(by(r, 'Operating Expenses')!.margin).toBeUndefined();
    expect(by(r, 'Gross Profit')!.margin).toBe(40);
  });

  it('does not turn a non-numeric margin into 0', () => {
    const r = incomeStatementPackRows({ revenue: 100, grossMargin: 'x', netProfit: 10, netMargin: 10 });
    expect(by(r, 'Gross Profit')!.margin).toBeNull();
  });
});
