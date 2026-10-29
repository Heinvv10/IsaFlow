/**
 * The tracking engine over a DATE RANGE (budgets P3 PR-C): the entry point of
 * `getBudgetVariance`'s facade, so the comparator, MCP, the board pack and the
 * old Budget vs Actual routes read the engine's lines, not a second SQL. The
 * steps it shares with the Budget vs Actual report are `trackingCore`'s.
 *
 * It differs from `buildBudgetTrackingReport` only where P0's date-range
 * contract needs it to:
 *   - Day-level edges. Actuals are the posted lines from `startDate` to
 *     `endDate` inclusive, read exactly, and the budget is every calendar month
 *     the range touches, whole (P0's rule). No 24-month cap here: MCP may ask
 *     for any range (the comparator route caps its own).
 *   - Versions per year by P1's own scope (`primaryVersionScope`), so a registry
 *     year that starts mid-month is read the way the budgets page writes it (a
 *     shared month counts once, in the earlier year), not refused with a 409.
 *     The year holding the range's end is judged for the absent rule even when
 *     that split left it no month.
 *   - `splitsMonth`: the range cuts a budget month (a start that is not the 1st,
 *     an end that is not a month end, or a registry year starting or ending
 *     mid-month inside it). With `wholeMonthsOnly` the whole window's budget is
 *     then absent (the comparator's mode): a budget month cannot be split
 *     without inventing a number.
 *   - No members, and no projection anyone reads: the line builder's plan is
 *     the range itself as its "year", dated at its own end, so a line with a
 *     budget in the range is kept and nothing depends on the clock.
 * Everything else is the engine's: the dimension filter (404 / 400), the
 * classes, absent years, partial lines and their verdicts, bands, notices, the
 * version (404 foreign; 400 when the range reaches another year). Queries are
 * sequential (one pg client under withAuth).
 */
import { addDaysISO } from '@/lib/dateUtils';
import { fiscalYearForDate, type FiscalYearRecord } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import { budgetMonthKeysInWindow, monthEnd } from '@/modules/accounting/services/reports/budgetPeriodWindow';
import { primaryVersionScope } from '../budgetVersionScope';
import { buildBands, buildNotices } from './trackingBands';
import { namedVersionScopeOf, versionHeads } from './trackingBudgetRead';
import { readPostedThrough } from './trackingActualRead';
import { trackingCore } from './trackingCore';
import { resolveTrackingFilter } from './trackingFilter';
import { projectionPlan } from './trackingProjection';
import type { BudgetTrackingReport, TrackingBand, TrackingLine, TrackingNotices, TrackingVersionRef, WindowYear } from './trackingTypes';
import { mapRegistryMiss } from './trackingWindow';

export interface RangeTrackingOptions {
  versionId?: string;
  cc1Id?: string;
  cc2Id?: string;
  buId?: string;
  /** Either level (`cc1_id = X OR cc2_id = X`): the income statement page's `cost_centre_id`. */
  costCentreId?: string;
  /** A range that splits a budget month has no window budget at all. */
  wholeMonthsOnly?: boolean;
}

export interface RangeTracking {
  /** The registry label of the year holding `startDate` (P0's `fiscalYear`). */
  startFiscalYear: number;
  /** 'YYYY-MM' months the budget covers, in order. */
  months: string[];
  years: WindowYear[];
  lines: TrackingLine[];
  bands: TrackingBand[];
  notices: TrackingNotices;
  /** The WINDOW budget is absent (a year in it with no budget, or `wholeMonthsOnly` and a split month). */
  budgetAbsent: boolean;
  /** The range cuts a budget month (see the header). */
  splitsMonth: boolean;
  /** The version of the year holding the range's end; `empty` when it holds no budget in the range. */
  version: TrackingVersionRef | null;
  filter: BudgetTrackingReport['filter'];
  /** Latest posted, non-year-end entry date in the range, company-wide (P0's `postedThrough`). */
  postedThrough: string | null;
}

/** Every registry year [start, end] touches by date, in order (the year holding `start` first, always). */
async function yearsByDate(companyId: string, startDate: string, endDate: string): Promise<FiscalYearRecord[]> {
  const out = [await mapRegistryMiss(() => fiscalYearForDate(companyId, startDate))];
  for (let day = addDaysISO(out[0]!.endDate, 1); day <= endDate; day = addDaysISO(out[out.length - 1]!.endDate, 1)) {
    if (out.length > 200) throw new Error(`budget range ${startDate}..${endDate} spans too many years`);
    out.push(await mapRegistryMiss(() => fiscalYearForDate(companyId, day)));
  }
  return out;
}

/** Pure: the range cuts a budget month at its own edges or at a registry year's mid-month edge inside it. */
export function splitsBudgetMonth(startDate: string, endDate: string, years: ReadonlyArray<{ startDate: string; endDate: string }>): boolean {
  if (endDate < startDate) return false;
  if (!startDate.endsWith('-01') || endDate !== monthEnd(endDate)) return true;
  return years.some((y) => (y.startDate > startDate && !y.startDate.endsWith('-01'))
    || (y.endDate < endDate && y.endDate !== monthEnd(y.endDate)));
}

export async function buildRangeTracking(
  companyId: string,
  startDate: string,
  endDate: string,
  opts: RangeTrackingOptions = {},
): Promise<RangeTracking> {
  const months = budgetMonthKeysInWindow(startDate, endDate);
  const filter = await resolveTrackingFilter(companyId, opts);
  const dateYears = await yearsByDate(companyId, startDate, endDate);
  const primary = await mapRegistryMiss(() => primaryVersionScope(companyId, startDate, endDate));
  const scope = opts.versionId ? await namedVersionScopeOf(companyId, opts.versionId, primary) : primary;
  // Each scoped year with its months. The year holding the end is FY*: when P1 gave it no month (it
  // starts mid-month inside the range), `budgetAbsentYears` judges it over the range all the same.
  const years: WindowYear[] = scope.map((s) => ({ fiscalYear: s.fiscalYear, months: budgetMonthKeysInWindow(s.first, s.last) }));
  const splitsMonth = splitsBudgetMonth(startDate, endDate, dateYears);
  const last = dateYears[dateYears.length - 1]!;
  const rangeYear = { fiscalYear: last.fiscalYear, startDate, endDate };

  const core = months.length === 0 ? null : await trackingCore(companyId, {
    window: { months, years, fy: rangeYear },
    scope,
    filter,
    actuals: { from: startDate, to: endDate },
    plan: projectionPlan(rangeYear, endDate, endDate),
    groupBy: null,
    allAbsent: opts.wholeMonthsOnly === true && splitsMonth,
  });
  const lines = core?.lines ?? [];
  const absentYears = core?.absentYears ?? [];
  const outsideFilterYears = core?.outsideFilterYears ?? [];
  const budgetAbsent = (core?.noVersionMonths.length ?? 0) > 0;

  const lastVersionId = scope.find((s) => s.fiscalYear === last.fiscalYear)?.versionId ?? null;
  const heads = await versionHeads(companyId, lastVersionId === null ? [] : [lastVersionId]);
  const head = lastVersionId === null ? null : heads.get(lastVersionId) ?? null;
  const fyAbsent = absentYears.includes(last.fiscalYear);
  return {
    startFiscalYear: dateYears[0]!.fiscalYear,
    months,
    years,
    lines,
    bands: buildBands(lines, { budgetAbsent }),
    notices: buildNotices(lines, { noVersion: fyAbsent, noVersionYears: absentYears, budgetAbsent, outsideFilterYears }),
    budgetAbsent,
    splitsMonth,
    version: head && fyAbsent ? { ...head, empty: true } : head,
    filter: filter.members,
    postedThrough: await readPostedThrough(companyId, startDate, endDate),
  };
}
