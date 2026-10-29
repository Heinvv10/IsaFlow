/**
 * Budgets P3 lines and bands, review rounds 5-6 (moved unchanged out of trackingBands.test.ts for
 * the 300-line rule): over a window touching more than one financial year, a line budgeted in some
 * years only has a PARTIAL budget: absent window Budget / Var R / Var %, its band and the profit
 * totals above it absent too, no bridge; `notices.partialBudget` names the lines.
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

describe('review round 5 (G1): a cross-year window, budgeted in some years only', () => {
  const M26 = '2026-02';
  const M27 = '2026-03';
  const YEARS = [{ fiscalYear: 2026, months: [M26] }, { fiscalYear: 2027, months: [M27] }];
  const build2 = (budgets: ClassifiedBudgetCell[], windowYears = YEARS) => buildTrackingLines({
    accounts: ACCOUNTS, windowMonths: [M26, M27], plan: PLAN, windowYears,
    actuals: [{ accountId: 'sales', month: M26, amount: 100 }, { accountId: 'sales', month: M27, amount: 100 }, { accountId: 'rent', month: M27, amount: 40 }],
    budgets,
  });
  const cell = (accountId: string, month: string, amount: number, cls: ClassifiedBudgetCell['cls'] = 'included'): ClassifiedBudgetCell => ({ accountId, month, amount, cls });

  it('a line included in one year and not the other has no window budget; it is partial, not unbudgeted', () => {
    const lines = build2([cell('sales', M27, 90), cell('rent', M26, 20), cell('rent', M27, 20)]);
    const sales = lines.find((l) => l.accountId === 'sales')!;
    expect([sales.budget, sales.variance, sales.variancePct, sales.favourable, sales.partialBudget, sales.budgetAboveFilter]).toEqual([null, null, null, null, true, false]);
    expect(sales.monthly.map((m) => m.budget)).toEqual([null, 90]);
    const rent = lines.find((l) => l.accountId === 'rent')!;
    expect([rent.budget, rent.partialBudget]).toEqual([40, false]);
    expect(buildNotices(lines, { noVersion: false, noVersionYears: [], budgetAbsent: false }).unbudgetedCount).toBe(0);
    // Profit totals over a partial line are partial-window figures: absent, so no bridge.
    const bands = buildBands(lines);
    expect(['gross_profit', 'operating_profit', 'net_profit'].map((k) => bands.find((x) => x.key === k)!.budget)).toEqual([null, null, null]);
    expect(budgetBridgeSteps({ bands })).toEqual([]);
  });

  it('coarser rows in the other year set budgetAboveFilter; other-class rows never count as budget', () => {
    const lines = build2([cell('sales', M27, 90), cell('sales', M26, 300, 'coarser'), cell('rent', M26, 5, 'other'), cell('rent', M27, 20)]);
    const sales = lines.find((l) => l.accountId === 'sales')!;
    expect([sales.budget, sales.partialBudget, sales.budgetAboveFilter, sales.unallocatedBudget]).toEqual([null, true, true, 300]);
    const rent = lines.find((l) => l.accountId === 'rent')!;
    expect([rent.budget, rent.partialBudget]).toEqual([null, true]);
  });

  it('within one fiscal year the D5 per-month rule stays: a budget for some months is the budget', () => {
    // Rent (an expense band) is budgeted too: a band with lines and no budget would make net profit null (final R9).
    const lines = build2([cell('sales', M27, 90), cell('rent', M27, 20)], [{ fiscalYear: 2027, months: [M26, M27] }]);
    expect([lines[0]!.budget, lines[0]!.partialBudget]).toEqual([90, false]);
    expect(buildBands(lines).find((x) => x.key === 'net_profit')!.budget).toBe(70);
  });
});

describe('review round 6', () => {
  const M26 = '2026-02';
  const M27 = '2026-03';
  const YEARS = [{ fiscalYear: 2026, months: [M26] }, { fiscalYear: 2027, months: [M27] }];
  const cell = (accountId: string, month: string, amount: number): ClassifiedBudgetCell => ({ accountId, month, amount, cls: 'included' });
  // Sales and wages budgeted in FY2027 only (partial); interest, COS and rent in both years (whole).
  // Opex holds a partial line (wages) beside a whole one (rent).
  const LINES = buildTrackingLines({
    accounts: ACCOUNTS, windowMonths: [M26, M27], plan: PLAN, windowYears: YEARS,
    actuals: [{ accountId: 'sales', month: M27, amount: 100 }, { accountId: 'interest', month: M27, amount: 5 },
      { accountId: 'rent', month: M27, amount: 40 }, { accountId: 'wages', month: M27, amount: 30 }, { accountId: 'cos', month: M27, amount: 10 }],
    budgets: [cell('sales', M27, 90), cell('interest', M26, 2), cell('interest', M27, 2), cell('rent', M26, 20), cell('rent', M27, 20),
      cell('wages', M27, 25), cell('cos', M26, 4), cell('cos', M27, 4)],
  });

  it('F2: a band holding a partial line has no band budget; bands whose lines are whole keep theirs', () => {
    const bands = buildBands(LINES);
    const b = (k: string) => bands.find((x) => x.key === k)!;
    expect([b('turnover').budget, b('turnover').variance, b('turnover').favourable]).toEqual([null, null, null]);
    // Rent alone would give opex 40: a partial-window figure while wages sits blank beside it.
    expect([b('operating_expense').budget, b('operating_expense').variance, b('operating_expense').variancePct]).toEqual([null, null, null]);
    expect([b('other_income').budget, b('cost_of_sales').budget]).toEqual([4, 8]);
    expect([b('gross_profit').budget, b('operating_profit').budget, b('net_profit').budget]).toEqual([null, null, null]);
  });

  it('F3: notices.partialBudget counts the partial lines and keeps their actual per polarity; null when none', () => {
    expect(buildNotices(LINES, { noVersion: false, noVersionYears: [], budgetAbsent: false }).partialBudget)
      .toEqual({ count: 2, actual: { income: 100, expense: 30 } });
    expect(buildNotices(LINES.filter((l) => !l.partialBudget), { noVersion: false, noVersionYears: [], budgetAbsent: false }).partialBudget).toBeNull();
  });
});

describe('review round 3: a partial line is on the report even with no figure of its own', () => {
  const M26 = '2026-02';
  const M27 = '2026-03';
  const YEARS = [{ fiscalYear: 2026, months: [M26] }, { fiscalYear: 2027, months: [M27] }];
  // Sales is budgeted in FY2027 only (partial) and has no actual; rent is budgeted in both years.
  // FY2028's plan: the 2026 budget months are outside it, so the partial line has no FY budget either and only its verdict keeps it.
  const PLAN28 = projectionPlan({ fiscalYear: 2028, startDate: '2027-03-01', endDate: '2028-02-29' }, '2027-06-30', '2027-10-26');
  const lines = buildTrackingLines({
    accounts: ACCOUNTS, windowMonths: [M26, M27], plan: PLAN28, windowYears: YEARS,
    actuals: [{ accountId: 'rent', month: M27, amount: 40 }],
    budgets: [{ accountId: 'sales', month: M27, amount: 90, cls: 'included' }, { accountId: 'rent', month: M26, amount: 20, cls: 'included' },
      { accountId: 'rent', month: M27, amount: 20, cls: 'included' }],
  });

  it('the partial account is a line (the notice counts it and its band is null because of it), not dropped for having no actual', () => {
    expect(lines.map((l) => [l.accountId, l.budgetVerdict]).sort()).toEqual([['rent', 'budgeted'], ['sales', 'partial']]);
    const bands = buildBands(lines);
    expect([bands.find((x) => x.key === 'turnover')!.budget, bands.find((x) => x.key === 'operating_expense')!.budget]).toEqual([null, 40]);
    expect(buildNotices(lines, { noVersion: false, noVersionYears: [], budgetAbsent: false }).partialBudget?.count).toBe(1);
  });
});

describe('review round 3: a line kept only for the projection says nothing about the window budget', () => {
  it('rent has an FY budget in a later month, no window figure: its band is empty (0), not "lines with no budget", so net profit stays a figure', () => {
    const lines = buildTrackingLines({
      accounts: ACCOUNTS, windowMonths: [M], plan: PLAN,
      actuals: [{ accountId: 'sales', month: M, amount: 1000 }],
      budgets: [{ accountId: 'sales', month: M, amount: 900, cls: 'included' }, { accountId: 'rent', month: '2026-09', amount: 400, cls: 'included' }],
    });
    const rent = lines.find((l) => l.accountId === 'rent')!;
    expect([rent.budgetVerdict, rent.fyBudget, rent.actual]).toEqual(['unbudgeted', 400, 0]);
    const net = buildBands(lines).find((x) => x.key === 'net_profit')!;
    // Window: sales 900, no opex lines that speak. FY: sales 900 less rent 400.
    expect([net.budget, net.fyBudget]).toEqual([900, 500]);
  });
});
