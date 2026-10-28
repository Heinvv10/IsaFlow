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
import { buildBands, buildNotices } from './trackingBands';
import { readTrackingBudgets, resolveTrackingVersions } from './trackingBudgetRead';
import { readAccountOrder, readPostedThrough, readTrackingActuals } from './trackingActualRead';
import { buildTrackingMembers } from './trackingByMember';
import { classifyBudgetRow, effectiveDims } from './trackingDimRollup';
import { resolveTrackingFilter } from './trackingFilter';
import { buildTrackingLines, type AccountMeta } from './trackingLines';
import { projectionPlan } from './trackingProjection';
import { TrackingError, type BudgetTrackingReport, type TrackingParams } from './trackingTypes';
import { readStartOf, resolveTrackingWindow } from './trackingWindow';

export async function buildBudgetTrackingReport(
  companyId: string,
  params: TrackingParams,
  now: Date = new Date(),
): Promise<BudgetTrackingReport> {
  const today = localISODate(now);
  const window = await resolveTrackingWindow(companyId, params, now);
  const filter = await resolveTrackingFilter(companyId, params);
  const groupBy = params.groupBy ?? null;
  if (groupBy && Object.keys(filter.actual).length > 0) {
    throw new TrackingError(400, 'group_by needs the unfiltered view: the members partition the company total');
  }
  const versions = await resolveTrackingVersions(companyId, window, params.versionId);
  const plan = projectionPlan(window.fy, window.endDate, today);

  const budgetRows = await readTrackingBudgets(companyId, versions.scope);
  // Every chain the request needs (the budget rows' CC2s and the filter's), in ONE query.
  const chainIds = [...new Set([...filter.chainIds, ...budgetRows.map((r) => r.cc2Id).filter((v): v is string => v !== null)])];
  const nodes = await loadCostCentreChains(companyId, chainIds);
  const budgetFilter = filter.budgetFilter(nodes);
  const actualRows = await readTrackingActuals(companyId, readStartOf(window), window.endDate, filter.actual, groupBy);

  const accounts = new Map<string, AccountMeta>();
  for (const r of [...actualRows, ...budgetRows]) {
    if (!accounts.has(r.accountId)) {
      accounts.set(r.accountId, {
        accountId: r.accountId, accountCode: r.accountCode, accountName: r.accountName, accountType: r.accountType, accountSubtype: r.accountSubtype,
      });
    }
  }
  const effs = budgetRows.map((r) => effectiveDims(r, nodes));
  const noVersionMonths = window.years.filter((y) => versions.noVersionYears.includes(y.fiscalYear)).flatMap((y) => y.months);
  const lines = buildTrackingLines({
    noVersionMonths,
    accounts,
    windowMonths: window.months,
    plan,
    actuals: actualRows,
    budgets: budgetRows.map((r, i) => ({ accountId: r.accountId, month: r.month, amount: r.amount, cls: classifyBudgetRow(effs[i]!, budgetFilter) })),
    order: await readAccountOrder(companyId, [...accounts.keys()]),
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

  // "Actuals posted through" for the in-progress month runs from its 1st to TODAY; the window's
  // own posted-through (P0's definition) is read over the whole window.
  const inProgress = window.inProgressMonth
    ? { month: window.inProgressMonth, actualsTo: await readPostedThrough(companyId, `${window.inProgressMonth}-01`, today) }
    : null;
  const postedThrough = await readPostedThrough(companyId, window.startDate, window.endDate);

  const report: BudgetTrackingReport = {
    window: {
      period: window.period, label: window.label, startDate: window.startDate, endDate: window.endDate, months: window.months,
      fiscalYear: window.fiscalYear, inProgress, postedThrough, notStarted: window.notStarted,
    },
    version: versions.version,
    filter: filter.members,
    projection: { fiscalYear: plan.fiscalYear, cutoff: plan.cutoff, actualMonths: plan.actualMonths, budgetMonths: plan.budgetMonths },
    lines,
    bands: buildBands(lines),
    notices: buildNotices(lines, { noVersion: versions.version === null, noVersionYears: versions.noVersionYears, budgetAbsent: noVersionMonths.length > 0 }),
    years: await reportYearOptions(companyId, today),
  };
  if (versions.versionsByFy) report.versionsByFy = versions.versionsByFy;
  if (members) report.members = members;
  return report;
}
