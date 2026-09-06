import { describe, it, expect } from 'vitest';
import { applyBudgetComparator, applyTrend } from '@/modules/accounting/services/reports/statementRows/comparators';
import type { StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';
import type { BudgetVsActualLine } from '@/modules/accounting/services/reports/budgetVsActualLines';
import type { AccountTrends } from '@/modules/accounting/services/reports/trendRowsService';

function line(row: Partial<StatementRow> & { id: string; label: string; actual: number }): StatementRow {
  return { kind: 'line', depth: 1, ...row } as StatementRow;
}

function budgetLine(overrides: Partial<BudgetVsActualLine>): BudgetVsActualLine {
  return {
    account_code: '6000',
    account_name: 'Salaries',
    account_type: 'expense',
    budget_amount: 0,
    actual_amount: 0,
    variance: 0,
    variance_pct: 0,
    ...overrides,
  };
}

describe('applyBudgetComparator', () => {
  it('omits variancePct when the budget base is exactly zero', () => {
    const rows = [line({ id: '1', label: 'Salaries', accountCode: '6000', actual: 5500 })];
    const lines = [
      budgetLine({ account_code: '6000', budget_amount: 0, actual_amount: 5500, variance: -5500, variance_pct: 0 }),
    ];

    const [result] = applyBudgetComparator(rows, lines);

    expect(result.budget).toBeDefined();
    expect(result.budget!.value).toBe(0);
    expect(result.budget!.variance).toBe(5500);
    expect(result.budget!.variancePct).toBeUndefined();
  });

  it('keeps variancePct when the budget base is nonzero', () => {
    const rows = [line({ id: '1', label: 'Salaries', accountCode: '6000', actual: 5500 })];
    const lines = [
      budgetLine({ account_code: '6000', budget_amount: 5000, actual_amount: 5500, variance: -500, variance_pct: -10 }),
    ];

    const [result] = applyBudgetComparator(rows, lines);

    expect(result.budget!.value).toBe(5000);
    expect(result.budget!.variance).toBe(500);
    expect(result.budget!.variancePct).toBe(-10);
    expect(result.budget!.favourable).toBe(false);
  });

  it('leaves band and non-matching rows untouched', () => {
    const rows = [
      line({ id: 's', label: 'Expenses', kind: 'section' as const, actual: 0 }),
      line({ id: '2', label: 'Other', accountCode: '7000', actual: 100 }),
    ];
    const lines = [budgetLine({ account_code: '6000' })];

    const result = applyBudgetComparator(rows, lines);

    expect(result[0].budget).toBeUndefined();
    expect(result[1].budget).toBeUndefined();
  });
});

describe('applyTrend', () => {
  it('sets trend from the matching account series', () => {
    const rows = [line({ id: '1', label: 'Salaries', accountCode: '6000', actual: 5500 })];
    const trends: AccountTrends = {
      months: ['2026-01', '2026-02', '2026-03'],
      byAccountCode: { '6000': [1, 2, 3] },
      unavailable: {},
    };

    const [result] = applyTrend(rows, trends);

    expect(result.trend).toEqual([1, 2, 3]);
  });

  it('does not set trend for an account marked unavailable', () => {
    const rows = [line({ id: '1', label: 'Salaries', accountCode: '6000', actual: 5500 })];
    const trends: AccountTrends = {
      months: ['2026-01', '2026-02', '2026-03'],
      byAccountCode: { '6000': [1, 2, 3] },
      unavailable: { '6000': 'retained earnings' },
    };

    const [result] = applyTrend(rows, trends);

    expect(result.trend).toBeUndefined();
  });
});
