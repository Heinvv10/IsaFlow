/**
 * A Budget vs Actual tracking report (the `/api/accounting/reports-budget-tracking`
 * wire shape) for the page's component tests, built from the engine's own pure
 * modules (lines, bands, projection), so the figures and flags are the engine's,
 * not a hand-written guess at them. `trackingReport(rows, over)` takes one row
 * per account (actual and budget for the single window month) and overrides
 * for the window, version, notices and the rest.
 */
import { buildTrackingLines, type AccountMeta } from '@/modules/accounting/services/budgets/tracking/trackingLines';
import { buildBands } from '@/modules/accounting/services/budgets/tracking/trackingBands';
import { projectionPlan } from '@/modules/accounting/services/budgets/tracking/trackingProjection';
import type { BudgetTrackingReport } from '@/modules/accounting/services/budgets/tracking/trackingTypes';

export interface FixtureRow {
  code: string; name: string; type: 'revenue' | 'expense';
  actual: number;
  /** Omitted: no budget. `above`: the budget is set above the filter (coarser). */
  budget?: number; above?: boolean;
}

export const YEARS = [
  { fiscalYear: 2026, startDate: '2025-03-01', endDate: '2026-02-28', kind: 'normal' },
  { fiscalYear: 2027, startDate: '2026-03-01', endDate: '2027-02-28', kind: 'normal' },
];

export function trackingReport(rows: FixtureRow[], over: Partial<BudgetTrackingReport> = {}): BudgetTrackingReport {
  const M = '2026-10';
  const accounts = new Map<string, AccountMeta>(rows.map((r) => [r.code, {
    accountId: r.code, accountCode: r.code, accountName: r.name, accountType: r.type, accountSubtype: null,
  }]));
  const plan = projectionPlan({ fiscalYear: 2027, startDate: '2026-03-01', endDate: '2027-02-28' }, '2026-10-31', '2026-10-26');
  const lines = buildTrackingLines({
    accounts, windowMonths: [M], plan,
    actuals: rows.map((r) => ({ accountId: r.code, month: M, amount: r.actual })),
    budgets: rows.filter((r) => r.budget !== undefined)
      .map((r) => ({ accountId: r.code, month: M, amount: r.budget!, cls: r.above ? 'coarser' as const : 'included' as const })),
  });
  return {
    window: {
      period: 'month', label: 'October 2026', startDate: '2026-10-01', endDate: '2026-10-31', months: [M], fiscalYear: 2027,
      inProgress: { month: M, actualsTo: '2026-10-26' }, postedThrough: '2026-10-26', notStarted: false,
    },
    version: { id: 'v-primary', name: 'Original budget', kind: 'original', status: 'approved', isPrimary: true },
    filter: {},
    projection: { fiscalYear: 2027, cutoff: plan.cutoff, actualMonths: plan.actualMonths, budgetMonths: plan.budgetMonths, unbudgetedMonths: plan.unbudgetedMonths },
    lines,
    bands: buildBands(lines),
    notices: {
      unbudgetedCount: 0, unbudgetedActual: { income: 0, expense: 0 }, unallocatedBudget: { income: 0, expense: 0 },
      noVersion: false, partialBudget: null, noVersionYears: [],
    },
    years: YEARS,
    ...over,
  };
}
