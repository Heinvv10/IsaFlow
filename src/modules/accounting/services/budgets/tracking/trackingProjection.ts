/**
 * Projected FY (budgets P3 spec §2.3, contract decision 16). Pure.
 *
 *   cutoff      = min(window end, last day of the month BEFORE today's month),
 *                 clamped to [FY*.start − 1 day, FY*.end]
 *   projectedFY = actual(FY*.start .. cutoff) + Σ budget(FY* months after the cutoff's month)
 *   fyBudget    = Σ budget(every month of FY*)       -- 14 in a 14-month year
 *   projVar     = projectedFY − fyBudget            -- movement sign
 *
 * The cutoff is the last COMPLETE month: an in-progress month contributes its
 * budget, never its part-month actual (October's part actuals plus budget from
 * November would drop the rest of October's budget and bias the projection
 * low; pro-rating a budget month invents a figure).
 *
 * An UNBUDGETED line (no included budget anywhere in FY*) has no budget to
 * stand in for the months after the cutoff, so the cutoff would only drop real
 * postings (Projected FY below the YTD actual). Its projection is its posted
 * actual from FY* start through the month holding min(today, FY* end), the
 * in-progress month whole, forward-dated postings in it included, as the
 * Actual column counts them (`unbudgetedMonths`; PR-B review r1 ruling, for
 * Hein to confirm). Budgeted lines keep the cutoff rule; band and NP
 * projections stay sums of lines.
 *
 * Every window edge is a month end (`trackingWindow`), and so is the cutoff,
 * so "after the cutoff's month" is a comparison of 'YYYY-MM' keys.
 */
import { addDaysISO } from '@/lib/dateUtils';
import { budgetMonthKeysInWindow, monthEnd } from '@/modules/accounting/services/reports/budgetPeriodWindow';
import type { TrackingProjectionInfo } from './trackingTypes';

export interface ProjectionYear { fiscalYear: number; startDate: string; endDate: string }

export interface ProjectionPlan extends TrackingProjectionInfo {
  /** Every month of FY*. */
  fyMonths: string[];
}

// Pure calendar arithmetic, not `fiscalYearRegistry.dayBefore`: that module holds SQL, and the
// BvA page imports this file (through `trackingByMember`) into the browser bundle.
const dayBefore = (date: string): string => addDaysISO(date, -1);

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
    unbudgetedMonths: fyMonths.filter((m) => m <= today.slice(0, 7)),
  };
}

/** The last day an unbudgeted line's projection reads actuals to (a month end); null when FY* has not started. */
export function unbudgetedActualsTo(p: Pick<TrackingProjectionInfo, 'unbudgetedMonths'>): string | null {
  const last = p.unbudgetedMonths[p.unbudgetedMonths.length - 1];
  return last === undefined ? null : monthEnd(`${last}-01`);
}

/** The last day the actuals read must cover: the window end, or the end of the last unbudgeted month when later. */
export function readEndOf(window: { endDate: string }, plan: Pick<ProjectionPlan, 'unbudgetedMonths'>): string {
  const end = unbudgetedActualsTo(plan) ?? window.endDate;
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
 * month read (FY-to-date, not just the window's); `budgetByMonth` is null when
 * the account has no included budget anywhere in FY*.
 */
export function projectCents(
  actualByMonth: ReadonlyMap<string, number>,
  budgetByMonth: ReadonlyMap<string, number> | null,
  plan: ProjectionPlan,
): ProjectedCents {
  const sum = (map: ReadonlyMap<string, number>, ms: readonly string[]) => ms.reduce((s, m) => s + (map.get(m) ?? 0), 0);
  if (budgetByMonth === null) return { projected: sum(actualByMonth, plan.unbudgetedMonths), fyBudget: null, projVariance: null };
  const toDate = sum(actualByMonth, plan.actualMonths);
  const projected = toDate + sum(budgetByMonth, plan.budgetMonths);
  const fyBudget = sum(budgetByMonth, plan.fyMonths);
  return { projected, fyBudget, projVariance: projected - fyBudget };
}
