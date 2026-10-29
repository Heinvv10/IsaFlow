import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { vi } from 'vitest';
import {
  ComparatorNotices, comparatorNotices, BUDGET_NONE, BUDGET_FAILED, TREND_FAILED,
  COMPANY_WIDE_UNAVAILABLE, BUDGET_WHOLE_MONTHS, type BudgetInfo,
} from '@/components/accounting/reportControls/ComparatorNotices';

const INFO = (over: Partial<BudgetInfo> = {}): BudgetInfo => ({
  budgetAbsentYears: [], windowYears: [], unallocatedBudget: { income: 0, expense: 0 }, partialBudgetCount: 0, splitsMonth: false,
  retryAfterSecs: null, ...over,
});

afterEach(cleanup);

describe('comparatorNotices', () => {
  it('says nothing while every comparator is behaving', () => {
    expect(comparatorNotices({ budgetState: 'available', trendFailed: false })).toEqual([]);
    expect(comparatorNotices({ budgetState: 'unknown', trendFailed: false })).toEqual([]);
  });

  it('distinguishes a budget that was never captured from one that would not load', () => {
    // Both render an empty Budget column. Only one of them is a statement
    // about the period, and showing the wrong sentence tells the reader the
    // company has no budget when in fact nobody knows.
    const none = comparatorNotices({ budgetState: 'none', trendFailed: false });
    const failed = comparatorNotices({ budgetState: 'failed', trendFailed: false });
    expect(none).toEqual([{ tone: 'info', text: BUDGET_NONE }]);
    expect(failed).toEqual([{ tone: 'error', text: BUDGET_FAILED }]);
    expect(none[0]!.text).not.toBe(failed[0]!.text);
  });

  it('reports a failed trend fetch, which otherwise looks like an account with no series', () => {
    expect(comparatorNotices({ budgetState: 'unknown', trendFailed: true }))
      .toEqual([{ tone: 'error', text: TREND_FAILED }]);
  });

  it('explains the withheld company-wide columns first, before any other notice', () => {
    const notices = comparatorNotices({
      budgetState: 'unknown', trendFailed: false, companyWideUnavailable: true,
    });
    expect(notices).toEqual([{ tone: 'info', text: COMPANY_WIDE_UNAVAILABLE }]);
  });

  it('does not mention a cost centre when none is selected', () => {
    expect(comparatorNotices({ budgetState: 'unknown', trendFailed: false }))
      .not.toContainEqual({ tone: 'info', text: COMPANY_WIDE_UNAVAILABLE });
  });

  it('reports both failures at once rather than only the first', () => {
    expect(comparatorNotices({ budgetState: 'failed', trendFailed: true })).toHaveLength(2);
  });
});

describe('<ComparatorNotices />', () => {
  it('renders nothing at all when there is nothing to say', () => {
    const { container } = render(<ComparatorNotices budgetState="available" trendFailed={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('gives a failure the alert role so a screen reader announces it', () => {
    render(<ComparatorNotices budgetState="failed" trendFailed={false} />);
    expect(screen.getByRole('alert').textContent).toBe(BUDGET_FAILED);
  });

  it('does not shout about a legitimately absent budget', () => {
    render(<ComparatorNotices budgetState="none" trendFailed={false} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(BUDGET_NONE)).toBeInTheDocument();
  });
});

describe('comparatorNotices: the budget under a filter (budgets P3 PR-C)', () => {
  it('the dimension notice names the trend only: the budget column follows the filter now', () => {
    expect(COMPANY_WIDE_UNAVAILABLE).toMatch(/12-month trend/);
    expect(COMPANY_WIDE_UNAVAILABLE).not.toMatch(/budget/i);
  });

  it('a year with no budget in the window is named, never "no budget captured"', () => {
    const n = comparatorNotices({ budgetState: 'none', trendFailed: false, budget: INFO({ budgetAbsentYears: [2026] }) });
    expect(n).toEqual([{ tone: 'info', text: 'No budget for FY2026 in this window, so the Budget column is empty.' }]);
    expect(comparatorNotices({ budgetState: 'none', trendFailed: false, budget: INFO({ budgetAbsentYears: [2026, 2028] }) })[0]!.text)
      .toBe('No budget for FY2026 and FY2028 in this window, so the Budget column is empty.');
  });

  it('budget set above the filter is reported per polarity and never summed; it replaces "no budget captured"', () => {
    const n = comparatorNotices({ budgetState: 'none', trendFailed: false, budget: INFO({ unallocatedBudget: { income: 300, expense: 1200 } }) });
    expect(n).toHaveLength(1);
    expect(n[0]!.text).toMatch(/^R\s?300\.00 of income budget and R\s?1[\s ]?200\.00 of expense budget on these accounts is set at company level or above this filter/);
    expect(n[0]!.text).not.toMatch(/1[\s ]?500/);
    const avail = comparatorNotices({ budgetState: 'available', trendFailed: false, budget: INFO({ unallocatedBudget: { income: 0, expense: 1200 } }) });
    expect(avail[0]!.text).toMatch(/^R\s?1[\s ]?200\.00 of expense budget on these accounts/);
  });

  it('lines budgeted for only part of the window are named, beside a column that has budgets', () => {
    expect(comparatorNotices({ budgetState: 'available', trendFailed: false, budget: INFO({ partialBudgetCount: 2 }) }))
      .toEqual([{ tone: 'info', text: '2 accounts have a budget for only part of this window; their Budget is blank.' }]);
    expect(comparatorNotices({ budgetState: 'none', trendFailed: false, budget: INFO({ partialBudgetCount: 1 }) }))
      .toEqual([{ tone: 'info', text: '1 account has a budget for only part of this window; its Budget is blank.' }]);
  });

  it('a refused budget request says how long to wait, and offers a retry', () => {
    expect(comparatorNotices({ budgetState: 'limited', trendFailed: false, budget: INFO({ retryAfterSecs: 250 }) }))
      .toEqual([{ tone: 'error', text: 'Too many report requests, so the Budget column is empty: try again in 5 minutes.', retry: true }]);
    expect(comparatorNotices({ budgetState: 'limited', trendFailed: false, budget: INFO({ retryAfterSecs: 1 }) })[0]!.text)
      .toMatch(/try again in 1 second\.$/);
    // The shared withAuth limiter sends no Retry-After.
    expect(comparatorNotices({ budgetState: 'limited', trendFailed: false })[0]!.text).toMatch(/try again in about a minute\.$/);
  });
});

describe('<ComparatorNotices /> retry', () => {
  it('the refusal carries a Retry button that calls back once per click', () => {
    const onRetryBudget = vi.fn();
    render(<ComparatorNotices budgetState="limited" trendFailed={false} budget={INFO({ retryAfterSecs: 30 })} onRetryBudget={onRetryBudget} />);
    expect(screen.getByRole('alert').textContent).toContain('try again in 30 seconds.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetryBudget).toHaveBeenCalledTimes(1);
  });
});

describe('comparatorNotices: whole months and the years that do have a budget (PR-C review r1, R4, browser F4)', () => {
  it('a window that splits a budget month says budgets are set by whole month, and nothing else about the budget', () => {
    expect(comparatorNotices({ budgetState: 'none', trendFailed: false, budget: INFO({ splitsMonth: true, budgetAbsentYears: [2027] }) }))
      .toEqual([{ tone: 'info', text: BUDGET_WHOLE_MONTHS }]);
    expect(BUDGET_WHOLE_MONTHS).toBe('Budgets are set by whole month. Choose a window from the 1st to a month end to compare.');
  });

  it('a year with no budget names the year that has one: its budget alone covers only part of the window', () => {
    expect(comparatorNotices({ budgetState: 'none', trendFailed: false, budget: INFO({ budgetAbsentYears: [2028], windowYears: [2027, 2028] }) })[0]!.text)
      .toBe("No budget for FY2028 in this window, so the Budget column is empty. FY2027's budget alone would cover only part of it.");
  });
});
