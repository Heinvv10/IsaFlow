/**
 * Budget vs Actual tracking report (budgets P3 spec §2, §4): the one engine
 * behind the BvA page, its CSV/XLSX export and (from PR-C) `getBudgetVariance`.
 *
 * Steps, every query SEQUENTIAL: withAuth binds one pg client to the request,
 * and concurrent queries on it would interleave (see `packs/figures/packFigureSet.ts`).
 *   1. window (`trackingWindow`, the registry);
 *   2. the dimension filter, looked up under the company (404 on a miss);
 *   3. versions (primary per year unless one is named; 404 / 400 per §2.5);
 *   4. budget rows at their grain, the CC2 chains (loaded once), classified;
 *   5. actuals per account x month (FY* start .. window end, for the projection);
 *   6. lines, bands, notices, members; the in-progress month's posted-through date.
 *
 * Every figure is computed here or in the pure modules it calls, never by a
 * caller: the `statementRows/` adapter and the export copy.
 */
import { localISODate } from '@/lib/dateUtils';
import { reportYearOptions } from '@/modules/accounting/services/reports/budgetReportYear';
import { resolveDimensionMembers } from '@/modules/accounting/services/reports/dimensionPnlService';
import { loadCostCentreChains } from '@/modules/accounting/services/gl/dimensions/dimensionDerivation';
import { buildBands } from './trackingBands';
import { readTrackingBudgets, resolveTrackingVersions } from './trackingBudgetRead';
import { readPostedThrough, readTrackingActuals } from './trackingActualRead';
import { buildTrackingMembers } from './trackingByMember';
import { classifyBudgetRow, effectiveDims, isFiltered } from './trackingDimRollup';
import { resolveTrackingFilter } from './trackingFilter';
import { buildTrackingLines, fromCents, toCents, type AccountMeta } from './trackingLines';
import { projectionPlan } from './trackingProjection';
import { TrackingError, type BudgetTrackingReport, type TrackingLine, type TrackingNotices, type TrackingParams } from './trackingTypes';
import { resolveTrackingWindow } from './trackingWindow';

function notices(lines: readonly TrackingLine[], noVersion: boolean, noVersionYears: number[]): TrackingNotices {
  const unbudgeted = lines.filter((l) => l.budget === null && l.actual !== 0);
  return {
    unbudgetedCount: unbudgeted.length,
    unbudgetedActual: fromCents(unbudgeted.reduce((s, l) => s + Math.abs(toCents(l.actual)), 0)),
    unallocatedBudget: fromCents(lines.reduce((s, l) => s + toCents(l.unallocatedBudget), 0)),
    noVersion,
    noVersionYears,
  };
}

export async function buildBudgetTrackingReport(
  companyId: string,
  params: TrackingParams,
  now: Date = new Date(),
): Promise<BudgetTrackingReport> {
  const today = localISODate(now);
  const window = await resolveTrackingWindow(companyId, params, now);
  const filter = await resolveTrackingFilter(companyId, params);
  const groupBy = params.groupBy ?? null;
  if (groupBy && isFiltered(filter.budget)) {
    throw new TrackingError(400, 'group_by needs the unfiltered view: the members partition the company total');
  }
  const versions = await resolveTrackingVersions(companyId, window, params.versionId);
  const plan = projectionPlan(window.fy, window.endDate, today);

  const budgetRows = await readTrackingBudgets(companyId, versions.scope);
  const cc2Ids = [...new Set(budgetRows.map((r) => r.cc2Id).filter((v): v is string => v !== null))];
  const nodes = await loadCostCentreChains(companyId, cc2Ids);
  const readStart = window.startDate < window.fy.startDate ? window.startDate : window.fy.startDate;
  const actualRows = await readTrackingActuals(companyId, readStart, window.endDate, filter.actual, groupBy);

  const accounts = new Map<string, AccountMeta>();
  for (const r of [...actualRows, ...budgetRows]) {
    if (!accounts.has(r.accountId)) {
      accounts.set(r.accountId, {
        accountId: r.accountId, accountCode: r.accountCode, accountName: r.accountName, accountType: r.accountType, accountSubtype: r.accountSubtype,
      });
    }
  }
  const effs = budgetRows.map((r) => effectiveDims(r, nodes));
  const lines = buildTrackingLines({
    accounts,
    windowMonths: window.months,
    plan,
    actuals: actualRows,
    budgets: budgetRows.map((r, i) => ({ accountId: r.accountId, month: r.month, amount: r.amount, cls: classifyBudgetRow(effs[i]!, filter.budget) })),
  });

  let members: BudgetTrackingReport['members'];
  if (groupBy) {
    const ids = [...new Set([
      ...actualRows.map((r) => r.memberId),
      ...effs.map((e) => e[groupBy]),
    ].filter((v): v is string => v !== null))];
    const named = await resolveDimensionMembers(companyId, groupBy, ids);
    members = buildTrackingMembers({
      groupBy,
      windowMonths: window.months,
      actuals: actualRows,
      budgets: budgetRows.map((r, i) => ({ eff: effs[i]!, month: r.month, accountType: r.accountType, amount: r.amount })),
      names: new Map([...named].map(([id, m]) => [id.toLowerCase(), { code: m.code, name: m.name }])),
    });
  }

  const inProgress = window.inProgressMonth
    ? { month: window.inProgressMonth, actualsTo: await readPostedThrough(companyId, window.startDate, window.endDate) }
    : null;

  const report: BudgetTrackingReport = {
    window: {
      period: window.period, label: window.label, startDate: window.startDate, endDate: window.endDate, months: window.months,
      fiscalYear: window.fiscalYear, inProgress, notStarted: window.notStarted,
    },
    version: versions.version,
    filter: filter.members,
    projection: { fiscalYear: plan.fiscalYear, cutoff: plan.cutoff, actualMonths: plan.actualMonths, budgetMonths: plan.budgetMonths },
    lines,
    bands: buildBands(lines),
    notices: notices(lines, versions.version === null, versions.noVersionYears),
    years: await reportYearOptions(companyId, today),
  };
  if (versions.versionsByFy) report.versionsByFy = versions.versionsByFy;
  if (members) report.members = members;
  return report;
}
