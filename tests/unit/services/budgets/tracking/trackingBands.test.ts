/**
 * Budgets P3 §2.1: lines and bands. Bands are the income statement's, in its
 * order; band and profit budgets are computed in the ENGINE (Σ the band's
 * lines, an unbudgeted line counting 0), never by the adapter. Var R is the
 * movement (actual − budget) and good news is a separate polarity boolean.
 * "Unbudgeted" (no row) is not "budgeted at zero" (D5); there is no revenue +
 * expense total (D1).
 */
import { describe, expect, it } from 'vitest';
import { buildBands } from '@/modules/accounting/services/budgets/tracking/trackingBands';
import {
  buildTrackingLines,
  type AccountMeta,
  type ActualCell,
  type ClassifiedBudgetCell,
} from '@/modules/accounting/services/budgets/tracking/trackingLines';
import { projectionPlan } from '@/modules/accounting/services/budgets/tracking/trackingProjection';
import type { TrackingBand } from '@/modules/accounting/services/budgets/tracking/trackingTypes';

const meta = (accountId: string, accountCode: string, accountType: 'revenue' | 'expense', accountSubtype: string | null): AccountMeta =>
  ({ accountId, accountCode, accountName: `Account ${accountCode}`, accountType, accountSubtype });

const ACCOUNTS = new Map<string, AccountMeta>([
  ['sales', meta('sales', '4000', 'revenue', null)],
  ['interest', meta('interest', '4900', 'revenue', 'other_income')],
  ['cos', meta('cos', '5000', 'expense', 'cost_of_sales')],
  ['rent', meta('rent', '6000', 'expense', null)],
  ['wages', meta('wages', '6100', 'expense', null)],
  ['fin', meta('fin', '7000', 'expense', 'finance_cost')],
]);

const M = '2026-06';
const PLAN = projectionPlan({ fiscalYear: 2027, startDate: '2026-03-01', endDate: '2027-02-28' }, '2026-06-30', '2026-10-26');
const a = (accountId: string, amount: number): ActualCell => ({ accountId, month: M, amount });
const b = (accountId: string, amount: number, cls: ClassifiedBudgetCell['cls'] = 'included'): ClassifiedBudgetCell => ({ accountId, month: M, amount, cls });

function build(actuals: ActualCell[], budgets: ClassifiedBudgetCell[]) {
  const lines = buildTrackingLines({ accounts: ACCOUNTS, windowMonths: [M], plan: PLAN, actuals, budgets });
  const bands = buildBands(lines);
  const band = (key: TrackingBand['key']) => bands.find((x) => x.key === key)!;
  const line = (id: string) => lines.find((l) => l.accountId === id);
  return { lines, bands, band, line };
}

// Sales 1000 vs 900; interest 50 unbudgeted; COS 300 vs 400; rent 200 vs 150; wages budgeted at ZERO, actual 80; finance 20 vs 20.
const CASE = build(
  [a('sales', 1000), a('interest', 50), a('cos', 300), a('rent', 200), a('wages', 80), a('fin', 20)],
  [b('sales', 900), b('cos', 400), b('rent', 150), b('wages', 0), b('fin', 20)],
);

describe('bands', () => {
  it('come in the income statement order', () => {
    expect(CASE.bands.map((x) => x.key)).toEqual([
      'turnover', 'cost_of_sales', 'gross_profit', 'other_income', 'operating_expenses', 'operating_profit', 'other_expenses', 'net_profit',
    ]);
    expect(CASE.line('interest')!.band).toBe('other_income');
    expect(CASE.line('fin')!.band).toBe('other_expenses');
  });

  it('band budget = Σ its lines (unbudgeted = 0); band variance carries the unbudgeted actual', () => {
    expect([CASE.band('turnover').actual, CASE.band('turnover').budget]).toEqual([1000, 900]);
    expect([CASE.band('other_income').actual, CASE.band('other_income').budget, CASE.band('other_income').variance]).toEqual([50, null, null]);
    expect([CASE.band('operating_expenses').actual, CASE.band('operating_expenses').budget, CASE.band('operating_expenses').variance]).toEqual([280, 150, 130]);
  });

  it('profit totals follow the statement, never revenue + expense (D1)', () => {
    expect([CASE.band('gross_profit').actual, CASE.band('gross_profit').budget]).toEqual([700, 500]);
    // OP = GP + other income − opex; other income's budget is absent and counts 0.
    expect([CASE.band('operating_profit').actual, CASE.band('operating_profit').budget]).toEqual([470, 350]);
    expect([CASE.band('net_profit').actual, CASE.band('net_profit').budget, CASE.band('net_profit').variance]).toEqual([450, 330, 120]);
    expect(CASE.band('net_profit').kind).toBe('grand');
  });

  it('favourable by polarity: income up, expense down, profit up', () => {
    expect(CASE.band('turnover').favourable).toBe(true);
    expect(CASE.band('cost_of_sales').favourable).toBe(true);
    expect(CASE.band('operating_expenses').favourable).toBe(false);
    expect(CASE.band('net_profit').favourable).toBe(true);
    expect(CASE.line('cos')!.favourable).toBe(true);
    expect(CASE.line('rent')!.favourable).toBe(false);
  });

  it('a band whose only budgets are zero is budgeted at zero, not unbudgeted', () => {
    const z = build([a('wages', 80)], [b('wages', 0)]);
    expect([z.band('operating_expenses').budget, z.band('operating_expenses').variance, z.band('operating_expenses').variancePct]).toEqual([0, 80, null]);
    expect(z.band('operating_expenses').favourable).toBe(false);
  });

  it('a company with no budget leaves every band and total absent, never zero', () => {
    const none = build([a('sales', 10), a('rent', 4)], []);
    for (const x of none.bands) expect([x.key, x.budget, x.variance, x.favourable]).toEqual([x.key, null, null, null]);
    expect(none.band('net_profit').actual).toBe(6);
  });
});

describe('lines (D5)', () => {
  it('unbudgeted: budget, variance, % and favourable are absent', () => {
    const l = CASE.line('interest')!;
    expect([l.actual, l.budget, l.variance, l.variancePct, l.favourable]).toEqual([50, null, null, null, null]);
  });

  it('budgeted at zero: prints 0, the variance is the actual, % is absent', () => {
    const l = CASE.line('wages')!;
    expect([l.budget, l.variance, l.variancePct, l.favourable]).toEqual([0, 80, null, false]);
  });

  it('variance is the movement; % is variance / |budget|', () => {
    const l = CASE.line('cos')!;
    expect([l.variance, l.variancePct]).toEqual([-100, -25]);
  });

  it('a coarser budget is unallocated, never in the Budget column', () => {
    const c = build([a('rent', 200)], [b('rent', 500, 'coarser'), b('sales', 70, 'other')]);
    const l = c.line('rent')!;
    expect([l.budget, l.unallocatedBudget, l.budgetAboveFilter]).toEqual([null, 500, true]);
    expect(c.line('sales')).toBeUndefined();
    expect(c.band('net_profit').unallocatedBudget).toBe(500);
  });

  it('an account with neither actual nor budget is not printed', () => {
    expect(CASE.lines.map((l) => l.accountCode)).toEqual(['4000', '4900', '5000', '6000', '6100', '7000']);
    expect(build([a('sales', 0)], []).lines).toEqual([]);
  });
});
