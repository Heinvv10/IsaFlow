/**
 * The tracking engine's shared core (budgets P3): the steps the Budget vs
 * Actual report (`budgetTrackingService`) and the date-range entry point
 * (`trackingRange`, behind `getBudgetVariance`) both take, in ONE place:
 *
 *   budget rows of the scoped versions → the CC2 chains (one query) → the
 *   budget filter → actuals → each row classed included / coarser / other →
 *   budget-absent years → lines (with their verdicts), in the ledger's order.
 *
 * The callers decide what differs: the window and its years, the version
 * scope, the actuals range (FY*-wide for the report's projection, the exact
 * days for a date range), the projection plan, `groupBy`, and whether the
 * whole window's budget is absent regardless (a range that splits a budget
 * month). Queries are SEQUENTIAL: one pg client under withAuth.
 */
import { loadCostCentreChains, type CostCentreNode } from '@/modules/accounting/services/gl/dimensions/dimensionDerivation';
import type { VersionScope } from '../budgetVersionScope';
import { budgetAbsentYears, budgetOutsideFilterYears, readTrackingBudgets, type BudgetRow } from './trackingBudgetRead';
import { readAccountOrder, readTrackingActuals, type ActualRow } from './trackingActualRead';
import { classifyBudgetRow, effectiveDims, type EffDims } from './trackingDimRollup';
import type { ResolvedTrackingFilter } from './trackingFilter';
import { buildTrackingLines, type AccountMeta } from './trackingLines';
import type { ProjectionPlan } from './trackingProjection';
import type { TrackingGroupBy, TrackingLine, WindowYear } from './trackingTypes';

export interface TrackingCoreInput {
  window: { months: readonly string[]; years: readonly WindowYear[]; fy: { fiscalYear: number; startDate: string; endDate: string } };
  scope: readonly VersionScope[];
  filter: ResolvedTrackingFilter;
  /** Inclusive dates the actuals read covers. */
  actuals: { from: string; to: string };
  plan: ProjectionPlan;
  groupBy: TrackingGroupBy | null;
  /** Every window month's budget is absent, whatever the versions hold (a range that splits a budget month). */
  allAbsent?: boolean;
}

export interface TrackingCore {
  budgetRows: BudgetRow[];
  effs: EffDims[];
  nodes: ReadonlyMap<string, CostCentreNode>;
  actualRows: ActualRow[];
  lines: TrackingLine[];
  absentYears: number[];
  /** Years with a budget, none of it at the filter (R8). */
  outsideFilterYears: number[];
  /** Window months whose budget is absent: any of them makes the WINDOW budget absent. */
  noVersionMonths: string[];
}

export async function trackingCore(companyId: string, input: TrackingCoreInput): Promise<TrackingCore> {
  const { window, scope, filter, groupBy } = input;
  const budgetRows = await readTrackingBudgets(companyId, scope);
  // Every chain the request needs (the budget rows' CC2s and the filter's), in ONE query.
  const chainIds = [...new Set([...filter.chainIds, ...budgetRows.map((r) => r.cc2Id).filter((v): v is string => v !== null)])];
  const nodes = await loadCostCentreChains(companyId, chainIds);
  const budgetFilter = filter.budgetFilter(nodes);
  const actualRows = await readTrackingActuals(companyId, input.actuals.from, input.actuals.to, filter.actual, groupBy);

  const accounts = new Map<string, AccountMeta>();
  for (const r of [...actualRows, ...budgetRows]) {
    if (!accounts.has(r.accountId)) {
      accounts.set(r.accountId, {
        accountId: r.accountId, accountCode: r.accountCode, accountName: r.accountName, accountType: r.accountType, accountSubtype: r.accountSubtype,
      });
    }
  }
  const effs = budgetRows.map((r) => effectiveDims(r, nodes));
  const classified = budgetRows.map((r, i) => ({ accountId: r.accountId, month: r.month, amount: r.amount, cls: classifyBudgetRow(effs[i]!, budgetFilter) }));
  // Budget-absent years are decided from what this read returned, BEFORE the filter (review r2, R8):
  // no version, or no income-statement row at all in the year's window months. A year whose budget is
  // all at other dimensions has a budget, just not at this filter (`outsideFilterYears`).
  const absentYears = budgetAbsentYears(window, scope, classified);
  const outsideFilterYears = budgetOutsideFilterYears(window, scope, classified);
  const noVersionMonths = input.allAbsent
    ? [...window.months]
    : window.years.filter((y) => absentYears.includes(y.fiscalYear)).flatMap((y) => y.months);
  const lines = buildTrackingLines({
    noVersionMonths,
    accounts,
    windowMonths: window.months,
    plan: input.plan,
    actuals: actualRows,
    budgets: classified,
    windowYears: window.years,
    order: await readAccountOrder(companyId, [...accounts.keys()]),
  });
  return { budgetRows, effs, nodes, actualRows, lines, absentYears, outsideFilterYears, noVersionMonths };
}
