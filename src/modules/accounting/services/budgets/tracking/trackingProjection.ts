/**
 * Projected FY (budgets P3 spec §2.3, contract decision 16), month by month
 * over FY* (PR-B review r2 ruling, the lead's, for Hein to confirm). Pure.
 *
 *   cutoff      = min(window end, last day of the month BEFORE today's month),
 *                 clamped to [FY*.start − 1 day, FY*.end]
 *   projected(m) = actual(m)                         for months up to the cutoff's month
 *                = budget(m) if the line has a budget row for m, else actual(m)
 *                                                    for months after it
 *   projectedFY = Σ projected(m) over FY*
 *   fyBudget    = Σ budget(every month of FY*)       -- 14 in a 14-month year;
 *                 absent when the line has no budget in FY*
 *   projVar     = projectedFY − fyBudget            -- movement sign
 *
 * The cutoff is the last COMPLETE month: an in-progress month contributes its
 * budget, never its part-month actual (October's part actuals plus budget from
 * November would drop the rest of October's budget and bias the projection
 * low; pro-rating a budget month invents a figure).
 *
 * A month after the cutoff with NO budget row for the line has nothing to stand
 * in for its actual, so it keeps its actual (posted, forward-dated included;
 * 0 when none): the cutoff would otherwise drop real postings and put nothing
 * in their place (Projected FY below the Actual beside it; review r2 A1, A2,
 * B). A fully budgeted line is the spec's formula, unchanged; an unbudgeted
 * line projects its FY* actual; a partly budgeted one mixes month by month.
 * A budgeted zero is a budget row. Band and NP projections stay sums of lines.
 * The actuals read therefore covers the whole of FY* (`readEndOf`).
 *
 * Every window edge is a month end (`trackingWindow`), and so is the cutoff,
 * so "after the cutoff's month" is a comparison of 'YYYY-MM' keys.
 */
import { dayBefore } from '@/lib/dateUtils';
import { budgetMonthKeysInWindow, monthEnd } from '@/modules/accounting/services/reports/budgetPeriodWindow';
import type { TrackingProjectionInfo } from './trackingTypes';

export interface ProjectionYear { fiscalYear: number; startDate: string; endDate: string }

export interface ProjectionPlan extends TrackingProjectionInfo {
  /** Every month of FY*. */
  fyMonths: string[];
}

// `dayBefore` from lib/dateUtils, not through `fiscalYearRegistry` (which holds SQL): the BvA page
// imports this file into the browser bundle (tests/unit/guards/bvaPageClientImports.test.ts).
/** The last day whose actuals the projection uses. */
export function projectionCutoff(windowEnd: string, today: string, fy: ProjectionYear): string {
  const lastComplete = dayBefore(`${today.slice(0, 7)}-01`);
  const cutoff = windowEnd < lastComplete ? windowEnd : lastComplete;
  const floor = dayBefore(fy.startDate);
  if (cutoff < floor) return floor;
  return cutoff > fy.endDate ? fy.endDate : cutoff;
}

/** FY*'s months, split at the cutoff into actual months and budget months. */
export function projectionPlan(fy: ProjectionYear, windowEnd: string, today: string): ProjectionPlan {
  const cutoff = projectionCutoff(windowEnd, today, fy);
  const cutoffMonth = cutoff.slice(0, 7);
  const fyMonths = budgetMonthKeysInWindow(fy.startDate, fy.endDate);
  return {
    fiscalYear: fy.fiscalYear,
    cutoff,
    fyMonths,
    actualMonths: fyMonths.filter((m) => m <= cutoffMonth),
    budgetMonths: fyMonths.filter((m) => m > cutoffMonth),
    // The last COMPLETE month a window may be judged through (the heatmap): the cutoff's month, but
    // never past the month before today's. The cutoff is clamped up to FY*.start - 1, so on a window
    // running into a future FY* it alone would judge the month in progress (review r3 M1).
    judgedThrough: minMonth(cutoffMonth, dayBefore(`${today.slice(0, 7)}-01`).slice(0, 7)),
  };
}

const minMonth = (a: string, b: string) => (a < b ? a : b);

/** The last day the actuals read must cover: the window end or FY*'s last month end, whichever is later. */
export function readEndOf(window: { endDate: string }, plan: Pick<ProjectionPlan, 'fyMonths'>): string {
  const last = plan.fyMonths[plan.fyMonths.length - 1];
  const end = last === undefined ? window.endDate : monthEnd(`${last}-01`);
  return end > window.endDate ? end : window.endDate;
}

export interface ProjectedCents {
  projected: number;
  /** Null: no included budget for the account in FY*. */
  fyBudget: number | null;
  projVariance: number | null;
}

/**
 * One account's projection, in integer CENTS. `actualByMonth` holds every
 * month of FY* read (not just the window's); `budgetByMonth` holds the months
 * the line has an included budget row for, and is null when it has none
 * anywhere in FY*.
 */
export function projectCents(
  actualByMonth: ReadonlyMap<string, number>,
  budgetByMonth: ReadonlyMap<string, number> | null,
  plan: ProjectionPlan,
): ProjectedCents {
  const sum = (map: ReadonlyMap<string, number>, ms: readonly string[]) => ms.reduce((s, m) => s + (map.get(m) ?? 0), 0);
  const after = plan.budgetMonths.reduce(
    (s, m) => s + (budgetByMonth?.has(m) ? budgetByMonth.get(m)! : actualByMonth.get(m) ?? 0), 0);
  const projected = sum(actualByMonth, plan.actualMonths) + after;
  if (budgetByMonth === null) return { projected, fyBudget: null, projVariance: null };
  const fyBudget = sum(budgetByMonth, plan.fyMonths);
  return { projected, fyBudget, projVariance: projected - fyBudget };
}
