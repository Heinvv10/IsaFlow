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
 *   5. actuals per account x month (the window and the whole of FY*: a projected month with no
 *      budget keeps its actual);
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
import { budgetAbsentYears, readTrackingBudgets, resolveTrackingVersions } from './trackingBudgetRead';
import { readAccountOrder, readPostedThrough, readTrackingActuals } from './trackingActualRead';
import { buildTrackingMembers } from './trackingByMember';
import { classifyBudgetRow, effectiveDims } from './trackingDimRollup';
import { readMemberOrder, resolveTrackingFilter } from './trackingFilter';
import { buildTrackingLines, type AccountMeta } from './trackingLines';
import { projectionPlan, readEndOf } from './trackingProjection';
import { TrackingError, type BudgetTrackingReport, type TrackingParams } from './trackingTypes';
import { mapRegistryMiss, readStartOf, resolveTrackingWindow } from './trackingWindow';

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
  const actualRows = await readTrackingActuals(companyId, readStartOf(window), readEndOf(window, plan), filter.actual, groupBy);

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
  // Budget-absent years are decided from what this read returned, as the filter classes it (review
  // r4, r5): no version, or no included or coarser income-statement row in the year's window months.
  const absentYears = budgetAbsentYears(window, versions.scope, classified);
  const noVersionMonths = window.years.filter((y) => absentYears.includes(y.fiscalYear)).flatMap((y) => y.months);
  const lines = buildTrackingLines({
    noVersionMonths,
    accounts,
    windowMonths: window.months,
    plan,
    actuals: actualRows,
    budgets: classified,
    windowYears: window.years,
    order: await readAccountOrder(companyId, [...accounts.keys()]),
  });

  let members: BudgetTrackingReport['members'];
  if (groupBy) {
    const ids = [...new Set([
      ...actualRows.map((r) => r.memberId),
      ...effs.map((e) => e[groupBy]),
    ].filter((v): v is string => v !== null))];
    const named = await resolveDimensionMembers(companyId, groupBy, ids);
    const memberOrder = await readMemberOrder(companyId, groupBy, ids);
    members = buildTrackingMembers({
      groupBy,
      windowMonths: window.months,
      actuals: actualRows,
      budgets: budgetRows.map((r, i) => ({ eff: effs[i]!, month: r.month, accountType: r.accountType, amount: r.amount, accountId: r.accountId })),
      names: new Map([...named].map(([id, m]) => [id.toLowerCase(), { code: m.code, name: m.name }])),
      noVersionMonths,
      order: memberOrder,
      // Members partition NP: when a partial line leaves NP's budget absent, theirs is too.
      budgetAbsent: lines.some((l) => l.partialBudget),
      windowYears: window.years,
    });
  }

  // "Actuals posted through" for the in-progress month: the latest posting the FILTERED actuals read
  // consumed IN that month (review A4, r3 R3: a forward-dated posting Actual includes is named, so
  // the date never contradicts the figure). The window's own posted-through is P0's company-wide
  // figure over the whole window, any account (it can be forward-dated).
  const progressMonth = window.inProgressMonth;
  const consumed = actualRows.flatMap((r) => (r.month === progressMonth && r.lastPosted !== null ? [r.lastPosted] : []));
  const inProgress = progressMonth
    ? { month: progressMonth, actualsTo: consumed.length === 0 ? null : consumed.reduce((x, y) => (x > y ? x : y)) }
    : null;
  const postedThrough = await readPostedThrough(companyId, window.startDate, window.endDate);

  const report: BudgetTrackingReport = {
    window: {
      period: window.period, label: window.label, startDate: window.startDate, endDate: window.endDate, months: window.months,
      fiscalYear: window.fiscalYear, inProgress, postedThrough, notStarted: window.notStarted,
    },
    // FY*'s version that holds no budget in this window is marked, never presented as a budget (G2).
    version: versions.version && absentYears.includes(window.fy.fiscalYear) ? { ...versions.version, empty: true } : versions.version,
    filter: filter.members,
    projection: {
      fiscalYear: plan.fiscalYear, cutoff: plan.cutoff, actualMonths: plan.actualMonths, budgetMonths: plan.budgetMonths,
      judgedThrough: plan.judgedThrough,
    },
    lines,
    bands: buildBands(lines, { budgetAbsent: noVersionMonths.length > 0 }),
    notices: buildNotices(lines, {
      noVersion: absentYears.includes(window.fy.fiscalYear), noVersionYears: absentYears, budgetAbsent: noVersionMonths.length > 0,
    }),
    years: await mapRegistryMiss(() => reportYearOptions(companyId, today)),
  };
  if (versions.versionsByFy) {
    // A year's version that holds no budget in this window is marked, never presented as a budget.
    report.versionsByFy = Object.fromEntries(Object.entries(versions.versionsByFy).map(([y, v]) =>
      [y, absentYears.includes(Number(y)) ? { ...v, empty: true as const } : v]));
  }
  if (members) report.members = members;
  return report;
}
