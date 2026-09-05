import { describe, it, expect } from 'vitest';
import { hasBudget } from '@/components/accounting/reportControls/useStatementComparators';
import { DENSITY_COLUMNS } from '@/components/accounting/reportControls/useComparatorColumns';
import type { BudgetVsActualLine } from '@/modules/accounting/services/reports/budgetVsActualLines';

const line = (budget: number): BudgetVsActualLine => ({
  account_code: '6000', account_name: 'Rent', account_type: 'expense',
  budget_amount: budget, actual_amount: 100, variance: 0, variance_pct: 0,
});

describe('hasBudget', () => {
  it('is false when the company has accounts but no budget on any of them', () => {
    // getBudgetVariance returns every account it classified, budgeted or not,
    // so a non-empty list is not evidence that a budget was ever captured.
    expect(hasBudget([line(0), line(0)])).toBe(false);
  });

  it('is true as soon as one account carries a budget', () => {
    expect(hasBudget([line(0), line(25000)])).toBe(true);
  });

  it('is false for no accounts at all', () => {
    expect(hasBudget([])).toBe(false);
  });
});

describe('DENSITY_COLUMNS', () => {
  it('opens the owner view with a clean statement', () => {
    expect(DENSITY_COLUMNS.owner).toEqual({ prior: false, budget: false, variance: false, trend: false });
  });

  it('opens the accountant view on prior and variance, and never on a variance with nothing behind it', () => {
    expect(DENSITY_COLUMNS.accountant.prior).toBe(true);
    expect(DENSITY_COLUMNS.accountant.variance).toBe(true);
    expect(DENSITY_COLUMNS.accountant.variance && !DENSITY_COLUMNS.accountant.prior
      && !DENSITY_COLUMNS.accountant.budget).toBe(false);
  });
});
