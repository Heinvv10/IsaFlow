/**
 * Budgets P3 §2.1: lines and bands. Bands are the income statement's, in its
 * order; band and profit budgets are computed in the ENGINE (Σ the band's
 * lines, an unbudgeted line counting 0), never by the adapter. Var R is the
 * movement (actual − budget) and good news is a separate polarity boolean.
 * "Unbudgeted" (no row) is not "budgeted at zero" (D5); there is no revenue +
 * expense total (D1).
 */
import { describe, expect, it, vi } from 'vitest';

const logError = vi.fn();
vi.mock('@/lib/logger', () => ({ log: { error: (...a: unknown[]) => logError(...a), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
import { buildBands, buildNotices } from '@/modules/accounting/services/budgets/tracking/trackingBands';
import { budgetBridgeSteps } from '@/modules/accounting/services/budgets/tracking/budgetBridgeSteps';
import {
  TrackingOrderError,
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
      'turnover', 'cost_of_sales', 'gross_profit', 'other_income', 'operating_expense', 'operating_profit', 'other_expense', 'net_profit',
    ]);
    expect(CASE.line('interest')!.band).toBe('other_income');
    expect(CASE.line('fin')!.band).toBe('other_expense');
  });

  it('band budget = Σ its lines (unbudgeted = 0); band variance carries the unbudgeted actual', () => {
    expect([CASE.band('turnover').actual, CASE.band('turnover').budget]).toEqual([1000, 900]);
    expect([CASE.band('other_income').actual, CASE.band('other_income').budget, CASE.band('other_income').variance]).toEqual([50, null, null]);
    expect([CASE.band('operating_expense').actual, CASE.band('operating_expense').budget, CASE.band('operating_expense').variance]).toEqual([280, 150, 130]);
  });

  // The same ledger with interest budgeted at 40: every band has a budget, so the profit totals are figures.
  const FULL = build(
    [a('sales', 1000), a('interest', 50), a('cos', 300), a('rent', 200), a('wages', 80), a('fin', 20)],
    [b('sales', 900), b('interest', 40), b('cos', 400), b('rent', 150), b('wages', 0), b('fin', 20)],
  );

  it('profit totals follow the statement, never revenue + expense (D1)', () => {
    expect([FULL.band('gross_profit').actual, FULL.band('gross_profit').budget]).toEqual([700, 500]);
    // OP = GP + other income − opex.
    expect([FULL.band('operating_profit').actual, FULL.band('operating_profit').budget]).toEqual([470, 390]);
    expect([FULL.band('net_profit').actual, FULL.band('net_profit').budget, FULL.band('net_profit').variance]).toEqual([450, 370, 80]);
    expect(FULL.band('net_profit').kind).toBe('grand');
  });

  it('a band whose lines have no budget is null, and every profit total netting it is null too (final R9)', () => {
    // CASE: interest (other income) has an actual and no budget. Gross profit does not net it; operating and net profit do.
    expect([CASE.band('other_income').budget, CASE.band('gross_profit').budget]).toEqual([null, 500]);
    expect([CASE.band('operating_profit').budget, CASE.band('net_profit').budget, CASE.band('net_profit').variance]).toEqual([null, null, null]);
    expect(CASE.band('net_profit').actual).toBe(450);
  });

  it('a band whose only budgets are zero is budgeted at zero, not unbudgeted', () => {
    const z = build([a('wages', 80)], [b('wages', 0)]);
    expect([z.band('operating_expense').budget, z.band('operating_expense').variance, z.band('operating_expense').variancePct]).toEqual([0, 80, null]);
    expect(z.band('operating_expense').favourable).toBe(false);
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
    // Netted by profit polarity like every profit figure (D1): an expense's unallocated budget lowers it.
    expect(c.band('net_profit').unallocatedBudget).toBe(-500);
  });

  it('an account with neither actual nor budget is not printed', () => {
    expect(CASE.lines.map((l) => l.accountCode)).toEqual(['4000', '4900', '5000', '6000', '6100', '7000']);
    expect(build([a('sales', 0)], []).lines).toEqual([]);
  });
});

describe('review round 1', () => {
  const M2 = '2026-07';
  const two = (budgets: ClassifiedBudgetCell[], noVersionMonths: string[]) => {
    const lines = buildTrackingLines({
      accounts: ACCOUNTS, windowMonths: [M, M2], plan: PLAN, noVersionMonths,
      actuals: [a('sales', 1000), { accountId: 'sales', month: M2, amount: 700 }, a('rent', 200)],
      budgets,
    });
    return { lines, bands: buildBands(lines) };
  };

  it('F1: a window month in a year with no version makes the window budget absent on every line and band', () => {
    // June is budgeted; July lies in a year with no version.
    const r = two([b('sales', 900), b('rent', 150)], [M2]);
    for (const l of r.lines) expect([l.accountCode, l.budget, l.variance, l.variancePct, l.favourable]).toEqual([l.accountCode, null, null, null, null]);
    for (const x of r.bands) expect([x.key, x.budget, x.variance, x.variancePct, x.favourable]).toEqual([x.key, null, null, null, null]);
    // The per-month budget stays: June's is a real figure, July's absent.
    const sales = r.lines.find((l) => l.accountId === 'sales')!;
    expect(sales.monthly.map((m) => [m.month, m.budget])).toEqual([[M, 900], [M2, null]]);
    // No budget base, no bridge.
    expect(budgetBridgeSteps(r)).toEqual([]);
    // The same budgets with July versioned keep their budget.
    expect(two([b('sales', 900), b('rent', 150)], []).lines.find((l) => l.accountId === 'sales')!.budget).toBe(900);
  });

  it('F3: an account whose budget is set above the filter is not counted as unbudgeted', () => {
    const lines = buildTrackingLines({
      accounts: ACCOUNTS, windowMonths: [M], plan: PLAN,
      actuals: [a('rent', 200), a('interest', 50)],
      budgets: [b('rent', 500, 'coarser')],
    });
    const n = buildNotices(lines, { noVersion: false, noVersionYears: [], budgetAbsent: false });
    expect(n.unbudgetedCount).toBe(1);
    expect(n.unbudgetedActual).toEqual({ income: 50, expense: 0 });
  });

  it('F4: notices keep income and expense apart; profit rows net unallocated budget by polarity', () => {
    const lines = buildTrackingLines({
      accounts: ACCOUNTS, windowMonths: [M], plan: PLAN,
      actuals: [a('interest', 50), a('wages', 30), a('sales', 10)],
      budgets: [b('sales', 400, 'coarser'), b('rent', 120, 'coarser'), b('cos', 30, 'coarser')],
    });
    const n = buildNotices(lines, { noVersion: false, noVersionYears: [], budgetAbsent: false });
    expect(n.unbudgetedActual).toEqual({ income: 50, expense: 30 });
    expect(n.unbudgetedCount).toBe(2);
    expect(n.unallocatedBudget).toEqual({ income: 400, expense: 150 });
    const bands = buildBands(lines);
    const un = (k: string) => bands.find((x) => x.key === k)!.unallocatedBudget;
    expect([un('turnover'), un('cost_of_sales'), un('gross_profit'), un('operating_expense'), un('operating_profit'), un('net_profit')])
      .toEqual([400, 30, 370, 120, 250, 250]);
  });

  it('F1: with the window budget absent nothing is called unbudgeted (the no-version notice says why)', () => {
    const r = two([b('sales', 900)], [M2]);
    const n = buildNotices(r.lines, { noVersion: true, noVersionYears: [2028], budgetAbsent: true });
    expect([n.unbudgetedCount, n.unbudgetedActual, n.noVersionYears]).toEqual([0, { income: 0, expense: 0 }, [2028]]);
  });
});

describe('line order (review Q5)', () => {
  it("prints lines in the order given (Postgres' ORDER BY account_code), not a JS comparison", () => {
    const actuals = [a('sales', 1), a('rent', 2), a('cos', 3)];
    const order = ['rent', 'cos', 'sales'];
    const lines = buildTrackingLines({ accounts: ACCOUNTS, windowMonths: [M], plan: PLAN, actuals, budgets: [], order });
    expect(lines.map((l) => l.accountId)).toEqual(order);
    expect(() => buildTrackingLines({ accounts: ACCOUNTS, windowMonths: [M], plan: PLAN, actuals, budgets: [], order: ['rent'] }))
      .toThrow(/missing from the print order/);
  });
});

describe('review round 2', () => {
  const M2 = '2026-07';
  const lines2 = (budgets: ClassifiedBudgetCell[], noVersionMonths: string[] = []) => buildTrackingLines({
    accounts: ACCOUNTS, windowMonths: [M, M2], plan: PLAN, noVersionMonths,
    actuals: [a('sales', 1000), { accountId: 'sales', month: M2, amount: 700 }, a('rent', 200)],
    budgets,
  });

  it('A2: under the no-version gap unallocated budget is absent on lines, bands and the footer', () => {
    const lines = lines2([b('rent', 150, 'coarser'), b('sales', 900)], [M2]);
    for (const l of lines) expect([l.accountId, l.unallocatedBudget]).toEqual([l.accountId, null]);
    for (const x of buildBands(lines)) expect([x.key, x.unallocatedBudget]).toEqual([x.key, null]);
    expect(buildNotices(lines, { noVersion: false, noVersionYears: [2028], budgetAbsent: true }).unallocatedBudget).toBeNull();
  });

  it('A3: included in one versioned month and only above the filter in another: no window budget, above the filter', () => {
    // Sales: June at the included grain, July only coarser (another version budgeted it at company level).
    const lines = lines2([b('sales', 900), { accountId: 'sales', month: M2, amount: 300, cls: 'coarser' }, b('rent', 150), { accountId: 'rent', month: M2, amount: 150, cls: 'included' }]);
    const sales = lines.find((l) => l.accountId === 'sales')!;
    expect([sales.budget, sales.variance, sales.variancePct, sales.favourable]).toEqual([null, null, null, null]);
    expect([sales.budgetAboveFilter, sales.unallocatedBudget]).toEqual([true, 300]);
    expect(sales.monthly.map((m) => m.budget)).toEqual([900, null]);
    // Rent, included in both months, keeps its budget; the band treats sales as unbudgeted (0).
    expect(lines.find((l) => l.accountId === 'rent')!.budget).toBe(300);
    const bands = buildBands(lines);
    expect(bands.find((x) => x.key === 'turnover')!.budget).toBeNull();
    // Review r5: a line whose budget covers part of the window makes the profit totals partial: absent.
    expect(bands.find((x) => x.key === 'net_profit')!.budget).toBeNull();
    expect(bands.find((x) => x.key === 'operating_expense')!.budget).toBe(300);
    // PR-B r2: the band and the totals above it say WHY their budget is absent (a partial line), so the
    // grid marks them partial rather than "No budget"; a whole band says nothing.
    expect(['turnover', 'gross_profit', 'operating_profit', 'net_profit'].map((k) => bands.find((x) => x.key === k)!.partialBudget))
      .toEqual([true, true, true, true]);
    expect(bands.find((x) => x.key === 'operating_expense')!.partialBudget).toBe(false);
    expect(buildNotices(lines, { noVersion: false, noVersionYears: [], budgetAbsent: false }).unbudgetedCount).toBe(0);
  });

  it('A3: a month with neither is not a grain change (a budget set for part of the window stays a budget)', () => {
    const lines = lines2([b('sales', 900)]);
    expect(lines.find((l) => l.accountId === 'sales')!.budget).toBe(900);
  });

  it('L1: an account missing from the print order is a typed, logged error', () => {
    logError.mockClear();
    expect(() => buildTrackingLines({ accounts: ACCOUNTS, windowMonths: [M], plan: PLAN, actuals: [a('sales', 1), a('rent', 2)], budgets: [], order: ['rent'] }))
      .toThrow(TrackingOrderError);
    expect(logError).toHaveBeenCalledWith(expect.stringMatching(/print order/), expect.objectContaining({ accountId: 'sales' }), 'budgets');
  });
});

describe('review round 3', () => {
  it('R1: with the window budget absent and no lines at all, every band has unallocated absent', () => {
    const bands = buildBands([], { budgetAbsent: true });
    for (const x of bands) expect([x.key, x.budget, x.unallocatedBudget]).toEqual([x.key, null, null]);
    // Without the gap an empty window is a real zero.
    expect(buildBands([]).find((x) => x.key === 'net_profit')!.unallocatedBudget).toBe(0);
  });
});
