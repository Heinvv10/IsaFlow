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
 * Every window edge is a month end (`trackingWindow`), and so is the cutoff,
 * so "after the cutoff's month" is a comparison of 'YYYY-MM' keys.
 */
import { addDaysISO } from '@/lib/dateUtils';
import { budgetMonthKeysInWindow } from '@/modules/accounting/services/reports/budgetPeriodWindow';
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
  };
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
  const toDate = sum(actualByMonth, plan.actualMonths);
  if (budgetByMonth === null) return { projected: toDate, fyBudget: null, projVariance: null };
  const projected = toDate + sum(budgetByMonth, plan.budgetMonths);
  const fyBudget = sum(budgetByMonth, plan.fyMonths);
  return { projected, fyBudget, projVariance: projected - fyBudget };
}
