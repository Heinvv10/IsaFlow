/**
 * The deck's income-statement slide and the income statement page read one
 * route (LB2-3 of PR #950): the slide must show what the page shows for the
 * same response — unspent-budget rows, engine band budgets, "—" for an
 * unbudgeted row, and the comparator's notices.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, within } from '@testing-library/react';
import { PresentSlide } from '@/components/accounting/present/PresentSlide';
import { BUDGET_FAILED, BUDGET_NONE, type BudgetInfo } from '@/components/accounting/reportControls/ComparatorNotices';
import type { Slide } from '@/components/accounting/present/presentSlides';
import type { IncomeStatementReport } from '@/modules/accounting/types/gl.types';
import type { BudgetVarianceTracked, TrackedLine } from '@/modules/accounting/services/reports/budgetVarianceTracked';

afterEach(cleanup);

const SLIDE: Slide = { id: 'is:0', kind: 'income_statement', title: 'Income Statement', data: {} };
const INCOME: IncomeStatementReport = {
  periodStart: '2026-09-01', periodEnd: '2026-09-30',
  revenue: [
    { accountCode: '4000', accountName: 'Sales', amount: 900 },
    { accountCode: '4100', accountName: 'Unbudgeted Fees', amount: 50 },
  ],
  otherIncome: [], costOfSales: [], operatingExpenses: [], otherExpenses: [],
  totalRevenue: 950, totalOtherIncome: 0, totalCostOfSales: 0,
  totalOperatingExpenses: 0, totalOtherExpenses: 0,
  grossProfit: 950, operatingProfit: 950, netProfit: 950,
};
const line = (o: Partial<TrackedLine>): TrackedLine => ({
  account_id: 'g', account_code: '4000', account_name: 'Sales', account_type: 'revenue',
  actual_amount: 900, budget_amount: 1000, variance: -100, movement: -100, budgeted: true,
  budget_verdict: 'budgeted', band: 'turnover', ...o,
} as TrackedLine);
const LINES: TrackedLine[] = [
  line({}),
  line({ account_id: 'u', account_code: '4100', account_name: 'Unbudgeted Fees', actual_amount: 50, budget_amount: 0, budgeted: false, budget_verdict: 'absent' }),
  line({ account_id: 't', account_code: '5250', account_name: 'Training Unspent', account_type: 'expense', actual_amount: 0, budget_amount: 321, band: 'operating_expense' }),
];
// 777 is not the sum of any lines: a band printed from the lines would differ.
const BANDS: BudgetVarianceTracked['bands'] = [
  { key: 'turnover', budget: 777 }, { key: 'operating_expense', budget: 321 }, { key: 'net_profit', budget: 456 },
];
const INFO: BudgetInfo = {
  budgetAbsentYears: [], budgetOutsideFilterYears: [], unallocatedBudget: null,
  partialBudgetCount: 0, splitsMonth: false, retryAfterSecs: null, rejection: null,
};

const render1 = (over: Partial<Parameters<typeof PresentSlide>[0]> = {}) => render(
  <PresentSlide slide={SLIDE} income={INCOME} trends={null} trendsFailed={false}
    budget={LINES} budgetBands={BANDS} budgetedCount={2} budgetInfo={INFO} budgetFailed={false} {...over} />,
).container;

const rowOf = (c: HTMLElement, label: string): HTMLElement => {
  const el = within(c).getAllByText(label)[0]!.closest('tr');
  if (!el) throw new Error(`no row for ${label}`);
  return el as HTMLElement;
};

describe('PresentSlide income slide matches the income statement page', () => {
  it('lists a budgeted account that has no actual (unspent budget row)', () => {
    const c = render1();
    expect(rowOf(c, 'Training Unspent').textContent).toContain('321');
  });

  it('prints the engine band budget, not the sum of the lines', () => {
    const c = render1();
    const turnover = rowOf(c, 'Total Turnover').textContent ?? '';
    expect(turnover).toContain('777');
    expect(turnover).not.toContain('1 000');
  });

  it('prints an unbudgeted row as "—", not a zero budget', () => {
    const c = render1();
    expect(rowOf(c, 'Unbudgeted Fees').querySelector('[title="No budget"]')).not.toBeNull();
  });

  it('shows the comparator notice when the response carries one', () => {
    const c = render1({ budgetInfo: { ...INFO, partialBudgetCount: 2 } });
    expect(c.textContent).toContain('2 accounts have a budget for only part of this window');
  });

  it('says the budget failed to load (an alert), rather than an empty column', () => {
    const c = render1({ budget: [], budgetBands: undefined, budgetedCount: 0, budgetFailed: true });
    expect(within(c).getByRole('alert').textContent).toContain(BUDGET_FAILED);
  });

  it('says no budget was captured when none was, and nothing while the fetch is in flight', () => {
    expect(render1({ budget: [], budgetBands: undefined, budgetedCount: 0 }).textContent).toContain(BUDGET_NONE);
    cleanup();
    expect(render1({ budget: [], budgetBands: undefined, budgetedCount: 0, budgetLoading: true }).textContent).not.toContain(BUDGET_NONE);
  });
});
