import { describe, it, expect } from 'vitest';
import { applyBudgetComparator, applyTrend } from '@/modules/accounting/services/reports/statementRows/comparators';
import { comparativeOnlyColumns } from '@/modules/accounting/services/reports/statementRows/statementModel';
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

  it('keeps variancePct when the budget base is nonzero, signed like variance not like the service', () => {
    const rows = [line({ id: '1', label: 'Salaries', accountCode: '6000', actual: 5500 })];
    // Salaries is an expense over budget: the service's own `variance` /
    // `variance_pct` are favourably signed (budget − actual → negative), but
    // the movement is +500 / +10% and variancePct must match that sign —
    // `favourable` alone carries the "this is bad" judgement.
    const lines = [
      budgetLine({ account_code: '6000', budget_amount: 5000, actual_amount: 5500, variance: -500, variance_pct: -10 }),
    ];

    const [result] = applyBudgetComparator(rows, lines);

    expect(result.budget!.value).toBe(5000);
    expect(result.budget!.variance).toBe(500);
    expect(result.budget!.variancePct).toBe(10);
    expect(result.budget!.favourable).toBe(false);
  });

  it('rounds the actual-less-budget subtraction to the cent, killing float noise', () => {
    // 130000.10 − 120000.20 evaluates to 9999.899999999994 in IEEE-754. Both
    // operands are rands to the cent, so the only thing round2 can remove is
    // that noise — and without it the screen prints a figure the export,
    // re-deriving the same subtraction, would round differently.
    expect(130_000.1 - 120_000.2).not.toBe(9999.9);

    const rows = [line({ id: '1', label: 'Salaries', accountCode: '6000', actual: 130_000.1 })];
    const lines = [
      budgetLine({
        account_code: '6000', budget_amount: 120_000.2, actual_amount: 130_000.1,
        variance: -9999.9, variance_pct: -8.33,
      }),
    ];

    const [result] = applyBudgetComparator(rows, lines);

    expect(result.budget!.variance).toBe(9999.9);
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

describe('comparativeOnlyColumns', () => {
  it('is the one fallback both statement bodies use', () => {
    expect(comparativeOnlyColumns(true))
      .toEqual({ prior: true, budget: false, variance: true, trend: false });
    expect(comparativeOnlyColumns(false))
      .toEqual({ prior: false, budget: false, variance: false, trend: false });
  });

  it('never leaves a variance column with no comparator behind it', () => {
    // Four empty cells per row read as missing data, not as "off".
    for (const showComparative of [true, false]) {
      const c = comparativeOnlyColumns(showComparative);
      expect(c.variance && !c.prior && !c.budget).toBe(false);
    }
  });
});
