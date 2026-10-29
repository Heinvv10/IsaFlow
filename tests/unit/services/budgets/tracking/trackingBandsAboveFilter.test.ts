/**
 * Budgets P3 PR-C review r2 (browser F3, ruling R9): a band whose only budget sits ABOVE the filter has
 * no budget at this filter, and the profit totals that net it have none either. Under a cost centre
 * with the income budget at company level, Operating and Net Profit were the expense budget alone, a
 * figure that read as a real target. An unbudgeted line (no budget anywhere) still counts 0, and a band
 * with no lines at all is empty, not unknown.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
import { buildBands } from '@/modules/accounting/services/budgets/tracking/trackingBands';
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

function bandsOf(budgets: ClassifiedBudgetCell[]) {
  const actuals = [{ accountId: 'sales', month: M, amount: 1000 }, { accountId: 'rent', month: M, amount: 200 }];
  const lines = buildTrackingLines({ accounts: ACCOUNTS, windowMonths: [M], plan: PLAN, actuals, budgets });
  const bands = buildBands(lines);
  return (key: string) => bands.find((b) => b.key === key)!.budget;
}

describe('a profit total nets only budgets that exist at the filter', () => {
  it('the income budget above the filter: gross, operating and net profit have no budget, the expense band keeps its own', () => {
    const budget = bandsOf([cell('sales', 5000, 'coarser'), cell('rent', 150, 'included')]);
    expect([budget('turnover'), budget('operating_expense')]).toEqual([null, 150]);
    expect([budget('gross_profit'), budget('operating_profit'), budget('net_profit')]).toEqual([null, null, null]);
  });

  it('the expense budget above the filter nulls the profit totals too (the mirror)', () => {
    const budget = bandsOf([cell('sales', 900, 'included'), cell('rent', 150, 'coarser')]);
    expect([budget('turnover'), budget('operating_expense')]).toEqual([900, null]);
    expect([budget('gross_profit')]).toEqual([900]);
    expect([budget('operating_profit'), budget('net_profit')]).toEqual([null, null]);
  });

  it('control: everything at the filter, or nothing budgeted at all, keeps the arithmetic (an empty or unbudgeted band counts 0)', () => {
    const whole = bandsOf([cell('sales', 900, 'included'), cell('rent', 150, 'included')]);
    expect([whole('gross_profit'), whole('operating_profit'), whole('net_profit')]).toEqual([900, 750, 750]);
    const onlyExpense = bandsOf([cell('rent', 150, 'included')]);
    expect([onlyExpense('turnover'), onlyExpense('net_profit')]).toEqual([null, -150]);
  });
});
