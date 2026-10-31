/**
 * `trackedVariance` (the `partialWindow: 'absent'` facade) keeps EVERY line the
 * engine retained (Codex P2 on PR #950): a partial or above-filter account with
 * no actual has its budget withheld, so P0's "unbudgeted zero/zero is dormant"
 * filter dropped it, leaving a partial count and blocked bands with no line.
 */
import { describe, expect, it } from 'vitest';
import { trackedVariance } from '@/modules/accounting/services/reports/budgetVarianceTracked';
import type { RangeTracking } from '@/modules/accounting/services/budgets/tracking/trackingRange';
import type { BudgetVerdict, TrackingLine } from '@/modules/accounting/services/budgets/tracking/trackingTypes';

const line = (code: string, verdict: BudgetVerdict, budget: number | null, actual: number): TrackingLine => ({
  accountId: `id-${code}`, accountCode: code, accountName: `Account ${code}`, accountType: 'expense', band: 'operating_expense',
  actual, budget, variance: budget === null ? null : actual - budget, variancePct: null, favourable: null,
  projected: 0, fyBudget: null, projVariance: null, projFavourable: null, unallocatedBudget: verdict === 'above-filter' ? 500 : 0,
  budgetAboveFilter: verdict === 'above-filter', fyBudgetAboveFilter: verdict === 'above-filter',
  partialBudget: verdict === 'partial', budgetVerdict: verdict, monthly: [],
});

const range = (lines: TrackingLine[]): RangeTracking => ({
  startFiscalYear: 2027, months: ['2026-12', '2027-03'], years: [], lines,
  bands: [{ key: 'operating_expense', budget: null } as RangeTracking['bands'][number]],
  notices: {
    unbudgetedCount: 0, unbudgetedActual: { income: 0, expense: 0 }, unallocatedBudget: { income: 0, expense: 500 },
    noVersion: false, partialBudget: { count: 1, actual: { income: 0, expense: 0 } }, noVersionYears: [], noBudgetAtFilterYears: [],
  },
  budgetAbsent: false, splitsMonth: false, version: null,
  filter: {} as RangeTracking['filter'], postedThrough: null,
});

describe('trackedVariance keeps the engine-retained lines', () => {
  it('a partial account with no actual is a line, flagged partial, beside the partial count', () => {
    const out = trackedVariance(range([line('5300', 'partial', null, 0), line('5200', 'budgeted', 100, 80)]));
    const partial = out.lines.find((l) => l.account_code === '5300');
    expect(partial).toMatchObject({ budget_verdict: 'partial', budget_partial: true, budgeted: false, budget_amount: 0, actual_amount: 0 });
    expect(out.partialBudgetCount).toBe(1);
    expect(out.lines.map((l) => l.account_code)).toEqual(['5300', '5200']);
    expect(out.rows.map((l) => l.account_code)).toEqual(['5200']);
  });

  it('an above-filter account with no actual is a line too, never counted unbudgeted', () => {
    const out = trackedVariance(range([line('5400', 'above-filter', null, 0)]));
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toMatchObject({ account_code: '5400', budget_verdict: 'above-filter', budgeted: false });
    expect(out.unbudgeted).toHaveLength(0);
    expect(out.universeTotal).toBe(1);
  });
});
