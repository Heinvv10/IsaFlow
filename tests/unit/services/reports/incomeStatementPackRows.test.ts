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

/**
 * ADVERSARIAL LOW-10 (TDD): the bottom line is COPIED from the caller — it is
 * the classifier's own figure (`gl/accountClassification#aggregateFigures`,
 * through `financialFiguresService`), and every surface that prints a net
 * profit prints that one number. Nothing here may re-derive it, round it, or
 * reconcile it against the bands, however equivalent the arithmetic looks:
 * the identity is enforced upstream, and a second derivation here is how two
 * surfaces come to print different bottom lines for the same period.
 */
describe('incomeStatementPackRows — the bottom line is copied, not derived', () => {
  const netProfitOf = (d: Record<string, unknown>) =>
    incomeStatementPackRows(d).find(r => r.key === 'netProfit')!.amount;

  it('returns the caller\'s netProfit bit for bit', () => {
    expect(netProfitOf(BRIGHTSPHERE)).toBe(BRIGHTSPHERE.netProfit);
  });

  it('does not round or re-scale it', () => {
    // Cents that a re-derivation through the bands would not reproduce.
    for (const n of [8394848.6, 0.01, -0.01, 1234567.89, -998877.66, 1e-2]) {
      expect(netProfitOf({ ...BRIGHTSPHERE, netProfit: n })).toBe(n);
    }
  });

  it('keeps it even when the bands do NOT foot to it', () => {
    // A blob whose bands sum nowhere near the bottom line. The row must still
    // be the caller's figure: reconciling it here would silently overwrite the
    // classifier and hide the real defect.
    const inconsistent = { ...BRIGHTSPHERE, netProfit: 42 };
    expect(netProfitOf(inconsistent)).toBe(42);
    const r = incomeStatementPackRows(inconsistent);
    const v = (l: string) => r.find(x => x.label === l)!.amount;
    expect(v('Operating Profit') - v('Other Expenses')).not.toBeCloseTo(42, 2);
  });

  it('keeps a loss as a loss', () => {
    expect(netProfitOf({ ...BRIGHTSPHERE, netProfit: -750000.25 })).toBe(-750000.25);
  });
});
