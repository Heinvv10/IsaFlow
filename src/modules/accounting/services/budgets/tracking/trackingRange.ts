/**
 * The tracking engine over a DATE RANGE (budgets P3 PR-C): the entry point of
 * `getBudgetVariance`'s facade, so the comparator, MCP, the board pack and the
 * old Budget vs Actual routes read the engine's lines, not a second SQL.
 *
 * It differs from `buildBudgetTrackingReport` (the BvA page) only where P0's
 * date-range contract needs it to:
 *   - Day-level edges. Actuals are the posted lines from `startDate` to
 *     `endDate` inclusive, read exactly (`readTrackingActuals`), and the budget
 *     is every calendar month the range touches, whole (P0's rule). There is no
 *     24-month cap: MCP may ask for any range.
 *   - Versions per year by P1's own scope (`primaryVersionScope`), so a registry
 *     year that starts mid-month is read the way the budgets page writes it (a
 *     shared month counts once, in the earlier year), not refused with a 409.
 *   - No projection and no members: the facade's shape has neither. The plan
 *     handed to `buildTrackingLines` is the range itself, whose projection
 *     fields nothing here reads.
 * Everything else is the engine's: the dimension filter (404 / 400), the
 * included / coarser / other classes, budget-absent years, partial lines, the
 * notices, the version (404 foreign; 400 when the range reaches another year).
 * Every query is sequential (one pg client under withAuth).
 */
import { localISODate } from '@/lib/dateUtils';
import { loadCostCentreChains } from '@/modules/accounting/services/gl/dimensions/dimensionDerivation';
import { budgetMonthKeysInWindow } from '@/modules/accounting/services/reports/budgetPeriodWindow';
import { primaryVersionScope, versionYear, type VersionScope } from '../budgetVersionScope';
import { buildNotices } from './trackingBands';
import { budgetAbsentYears, readTrackingBudgets, versionHeads } from './trackingBudgetRead';
import { readAccountOrder, readPostedThrough, readTrackingActuals } from './trackingActualRead';
import { classifyBudgetRow, effectiveDims } from './trackingDimRollup';
import { resolveTrackingFilter } from './trackingFilter';
import { buildTrackingLines, type AccountMeta } from './trackingLines';
import { projectionPlan } from './trackingProjection';
import {
  TrackingError, type BudgetTrackingReport, type TrackingLine, type TrackingNotices, type TrackingVersionRef, type WindowYear,
} from './trackingTypes';
import { mapRegistryMiss } from './trackingWindow';

export interface RangeTrackingOptions {
  versionId?: string;
  cc1Id?: string;
  cc2Id?: string;
  buId?: string;
  /** Either level (`cc1_id = X OR cc2_id = X`): the income statement page's `cost_centre_id`. */
  costCentreId?: string;
}

export interface RangeTracking {
  /** 'YYYY-MM' months the budget covers, in order. */
  months: string[];
  years: WindowYear[];
  lines: TrackingLine[];
  notices: TrackingNotices;
  /** The version of the year holding the range's end; `empty` when it holds no budget in the range. */
  version: TrackingVersionRef | null;
  filter: BudgetTrackingReport['filter'];
  /** Latest posted, non-year-end entry date in the range, company-wide (P0's `postedThrough`). */
  postedThrough: string | null;
}

/** The scope a named version reads: the range must lie inside the version's own year (the engine's rule). */
async function namedScope(companyId: string, versionId: string, years: readonly VersionScope[]): Promise<VersionScope[]> {
  const year = await mapRegistryMiss(() => versionYear(companyId, versionId));
  const other = years.find((y) => y.fiscalYear !== year.fiscalYear);
  if (other) throw new TrackingError(400, `version ${versionId} is FY${year.fiscalYear}; the window reaches FY${other.fiscalYear}`);
  return years.map((y) => ({ ...y, versionId }));
}

export async function buildRangeTracking(
  companyId: string,
  startDate: string,
  endDate: string,
  opts: RangeTrackingOptions = {},
  now: Date = new Date(),
): Promise<RangeTracking> {
  const months = budgetMonthKeysInWindow(startDate, endDate);
  const filter = await resolveTrackingFilter(companyId, opts);
  const primary = await mapRegistryMiss(() => primaryVersionScope(companyId, startDate, endDate));
  const scope = opts.versionId ? await namedScope(companyId, opts.versionId, primary) : primary;
  const years: WindowYear[] = scope.map((s) => ({ fiscalYear: s.fiscalYear, months: budgetMonthKeysInWindow(s.first, s.last) }));

  const budgetRows = await readTrackingBudgets(companyId, scope);
  const chainIds = [...new Set([...filter.chainIds, ...budgetRows.map((r) => r.cc2Id).filter((v): v is string => v !== null)])];
  const nodes = await loadCostCentreChains(companyId, chainIds);
  const budgetFilter = filter.budgetFilter(nodes);
  const actualRows = await readTrackingActuals(companyId, startDate, endDate, filter.actual);

  const accounts = new Map<string, AccountMeta>();
  for (const r of [...actualRows, ...budgetRows]) {
    if (!accounts.has(r.accountId)) {
      accounts.set(r.accountId, {
        accountId: r.accountId, accountCode: r.accountCode, accountName: r.accountName, accountType: r.accountType, accountSubtype: r.accountSubtype,
      });
    }
  }
  const classified = budgetRows.map((r) => ({ accountId: r.accountId, month: r.month, amount: r.amount, cls: classifyBudgetRow(effectiveDims(r, nodes), budgetFilter) }));
  const last = scope[scope.length - 1];
  const absentYears = last
    ? budgetAbsentYears({ years, fy: { fiscalYear: last.fiscalYear, startDate, endDate } }, scope, classified)
    : [];
  const noVersionMonths = years.filter((y) => absentYears.includes(y.fiscalYear)).flatMap((y) => y.months);
  const lines = buildTrackingLines({
    noVersionMonths,
    accounts,
    windowMonths: months,
    // Nothing reads the projection of a range; the plan only satisfies the line builder.
    plan: projectionPlan({ fiscalYear: last?.fiscalYear ?? 0, startDate, endDate }, endDate, localISODate(now)),
    actuals: actualRows,
    budgets: classified,
    windowYears: years,
    order: await readAccountOrder(companyId, [...accounts.keys()]),
  });

  const lastVersionId = last?.versionId ?? null;
  const heads = await versionHeads(companyId, lastVersionId === null ? [] : [lastVersionId]);
  const head = lastVersionId === null ? null : heads.get(lastVersionId) ?? null;
  const fyAbsent = last !== undefined && absentYears.includes(last.fiscalYear);
  return {
    months,
    years,
    lines,
    notices: buildNotices(lines, {
      noVersion: fyAbsent, noVersionYears: absentYears, budgetAbsent: noVersionMonths.length > 0,
    }),
    version: head && fyAbsent ? { ...head, empty: true } : head,
    filter: filter.members,
    postedThrough: await readPostedThrough(companyId, startDate, endDate),
  };
}
