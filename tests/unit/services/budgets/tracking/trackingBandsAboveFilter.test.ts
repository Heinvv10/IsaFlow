/**
 * Budgets P3 PR-C review r2 + r3, the lead's FINAL R9 ruling (window budget and the projection's FY budget):
 *   - a band's budget is null when a line in it is partial, when a line's budget sits only above the
 *     filter (strict: ONE such line is enough), or when the band has lines and none has a budget;
 *   - an unbudgeted line in a band that has a budgeted line counts 0; a band with no lines counts 0;
 *   - a profit total (and a P0 section) is null when any band it nets is null.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
import { buildBands, sectionBudgets } from '@/modules/accounting/services/budgets/tracking/trackingBands';
import { buildTrackingLines, type AccountMeta, type ClassifiedBudgetCell } from '@/modules/accounting/services/budgets/tracking/trackingLines';
import { projectionPlan } from '@/modules/accounting/services/budgets/tracking/trackingProjection';

const meta = (accountId: string, accountCode: string, accountType: 'revenue' | 'expense', accountSubtype: string | null): AccountMeta =>
  ({ accountId, accountCode, accountName: `Account ${accountCode}`, accountType, accountSubtype });
const ACCOUNTS = new Map<string, AccountMeta>([
  ['sales', meta('sales', '4000', 'revenue', null)],
  ['cos', meta('cos', '5000', 'expense', 'cost_of_sales')],
  ['rent', meta('rent', '6000', 'expense', null)],
]);
const M = '2026-06';
const PLAN = projectionPlan({ fiscalYear: 2027, startDate: '2026-03-01', endDate: '2027-02-28' }, '2026-06-30', '2026-10-26');
const cell = (accountId: string, amount: number, cls: ClassifiedBudgetCell['cls']): ClassifiedBudgetCell => ({ accountId, month: M, amount, cls });

const ACTUALS = [{ accountId: 'sales', month: M, amount: 1000 }, { accountId: 'rent', month: M, amount: 200 }];

function reportOf(budgets: ClassifiedBudgetCell[], actuals = ACTUALS) {
  const lines = buildTrackingLines({ accounts: ACCOUNTS, windowMonths: [M], plan: PLAN, actuals, budgets });
  const bands = buildBands(lines);
  return { lines, bands, sections: sectionBudgets(lines) };
}
const budgetOf = (bands: ReturnType<typeof buildBands>, key: string) => bands.find((b) => b.key === key)!.budget;
const fyOf = (bands: ReturnType<typeof buildBands>, key: string) => bands.find((b) => b.key === key)!.fyBudget;
const bandsOf = (budgets: ClassifiedBudgetCell[], actuals = ACTUALS) => {
  const { bands } = reportOf(budgets, actuals);
  return (key: string) => budgetOf(bands, key);
};
const PROFITS = ['gross_profit', 'operating_profit', 'net_profit'];

describe('a profit total nets only bands that have a budget (final R9)', () => {
  it('the income budget above the filter: gross, operating and net profit have no budget, the expense band keeps its own', () => {
    const budget = bandsOf([cell('sales', 5000, 'coarser'), cell('rent', 150, 'included')]);
    expect([budget('turnover'), budget('operating_expense')]).toEqual([null, 150]);
    expect(PROFITS.map(budget)).toEqual([null, null, null]);
  });

  it('the expense budget above the filter nulls the profit totals that net it (the mirror)', () => {
    const budget = bandsOf([cell('sales', 900, 'included'), cell('rent', 150, 'coarser')]);
    expect([budget('turnover'), budget('operating_expense')]).toEqual([900, null]);
    expect(budget('gross_profit')).toBe(900);
    expect([budget('operating_profit'), budget('net_profit')]).toEqual([null, null]);
  });

  it('a PARTLY-above band is null: one budgeted R0 line beside Wages above the filter is not a complete band (ledger R9-1)', () => {
    const accounts = new Map(ACCOUNTS).set('wages', meta('wages', '6100', 'expense', null));
    const lines = buildTrackingLines({
      accounts, windowMonths: [M], plan: PLAN,
      actuals: [{ accountId: 'sales', month: M, amount: 1000 }, { accountId: 'wages', month: M, amount: 100 }],
      budgets: [cell('sales', 1000, 'included'), cell('rent', 0, 'included'), cell('wages', 600, 'coarser')],
    });
    const bands = buildBands(lines);
    expect(budgetOf(bands, 'operating_expense')).toBeNull();
    expect([budgetOf(bands, 'operating_profit'), budgetOf(bands, 'net_profit')]).toEqual([null, null]);
    expect(sectionBudgets(lines)).toEqual({ revenue: 1000, expense: null, net_profit: null });
  });

  it('a band with lines and NO budget is null, and nulls the profit totals netting it (the expense side only is never a profit budget)', () => {
    const budget = bandsOf([cell('rent', 150, 'included')]);
    expect([budget('turnover'), budget('operating_expense')]).toEqual([null, 150]);
    expect(PROFITS.map(budget)).toEqual([null, null, null]);
    const mirror = bandsOf([cell('sales', 900, 'included')]);
    expect([mirror('turnover'), mirror('operating_expense'), mirror('gross_profit')]).toEqual([900, null, 900]);
    expect([mirror('operating_profit'), mirror('net_profit')]).toEqual([null, null]);
  });

  it('cost of sales with an actual and no budget nulls gross, operating and net profit (ledger R9-2)', () => {
    const budget = bandsOf([cell('sales', 900, 'included'), cell('rent', 150, 'included')], [...ACTUALS, { accountId: 'cos', month: M, amount: 400 }]);
    expect([budget('cost_of_sales'), budget('turnover'), budget('operating_expense')]).toEqual([null, 900, 150]);
    expect(PROFITS.map(budget)).toEqual([null, null, null]);
  });

  it('control: every band with lines has a budget (an unbudgeted line beside a budgeted one counts 0; an empty band counts 0), the arithmetic holds', () => {
    const accounts = new Map(ACCOUNTS).set('wages', meta('wages', '6100', 'expense', null));
    const lines = buildTrackingLines({
      accounts, windowMonths: [M], plan: PLAN,
      actuals: [...ACTUALS, { accountId: 'wages', month: M, amount: 50 }],
      budgets: [cell('sales', 900, 'included'), cell('rent', 150, 'included')],
    });
    const bands = buildBands(lines);
    // Wages has an actual and no budget: it counts 0 inside the opex band (Rent is budgeted); cost of sales has no lines: 0.
    expect([budgetOf(bands, 'operating_expense'), budgetOf(bands, 'cost_of_sales')]).toEqual([150, null]);
    expect(PROFITS.map((k) => budgetOf(bands, k))).toEqual([900, 750, 750]);
    expect(sectionBudgets(lines)).toEqual({ revenue: 900, expense: 150, net_profit: 750 });
  });

  it('no lines at all: every band and total stays absent, not zero', () => {
    const budget = bandsOf([], []);
    for (const k of ['turnover', ...PROFITS]) expect(budget(k)).toBeNull();
  });
});

describe('the same rule on the projection FY budget (ledger R9-3)', () => {
  // Sales is included for the whole year; Rent is coarser for the whole year (above the filter).
  const FY = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02'];
  const lines = buildTrackingLines({
    accounts: ACCOUNTS, windowMonths: [M], plan: PLAN,
    actuals: [{ accountId: 'sales', month: M, amount: 1000 }, { accountId: 'rent', month: M, amount: 200 }],
    budgets: FY.flatMap((m) => [
      { accountId: 'sales', month: m, amount: 1000, cls: 'included' as const }, { accountId: 'rent', month: m, amount: 400, cls: 'coarser' as const },
    ]),
  });
  const bands = buildBands(lines);

  it('net profit has neither a window budget nor an FY budget, and no projected variance', () => {
    expect(fyOf(bands, 'turnover')).toBe(12000);
    expect([fyOf(bands, 'operating_expense'), fyOf(bands, 'operating_profit'), fyOf(bands, 'net_profit')]).toEqual([null, null, null]);
    expect(bands.find((b) => b.key === 'net_profit')).toMatchObject({ budget: null, fyBudget: null, projVariance: null, projFavourable: null });
  });

  it('a band with lines and no FY budget nulls the FY budget of the totals netting it', () => {
    const noFy = buildTrackingLines({
      accounts: ACCOUNTS, windowMonths: [M], plan: PLAN, actuals: ACTUALS,
      budgets: [{ accountId: 'sales', month: M, amount: 900, cls: 'included' }],
    });
    expect(fyOf(buildBands(noFy), 'net_profit')).toBeNull();
  });
});
