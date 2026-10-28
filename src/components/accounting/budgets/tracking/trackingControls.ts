/**
 * The Budget vs Actual page's controls and the query string they send
 * (budgets P3 spec §2.2, §2.5, §4). Pure: no fetch, no Date read for a month.
 *
 * Only the parameters that apply to the period are sent; the route refuses
 * the others with a 400 (`trackingWindow.assertParamsApply`):
 *   month    → month (when chosen)
 *   quarter  → fiscal_year (when chosen) + quarter
 *   ytd, fy  → fiscal_year (when chosen)
 *   custom   → from + to
 * A version belongs to one financial year, so `version_id` is sent only while
 * the window lies in that year; a cross-year window reads each year's
 * primary, and the picker says why it is disabled. `group_by` (the bullets)
 * is sent only without a dimension filter: the route refuses the two
 * together.
 */
import type { ReportYearOption } from '@/modules/accounting/services/reports/budgetReportYear';
import type { TrackingGroupBy, TrackingPeriod } from '@/modules/accounting/services/budgets/tracking/trackingTypes';

export interface TrackingControls {
  period: TrackingPeriod;
  /** 'YYYY-MM'; '' = the month holding today. */
  month: string;
  /** A registry label; null = the year holding today. */
  fiscalYear: number | null;
  quarter: number;
  /** 'YYYY-MM' (custom). */
  from: string;
  to: string;
  /** '' = each year's primary version. */
  versionId: string;
  /** The financial year the chosen version belongs to. */
  versionFy: number | null;
  cc1Id: string;
  cc2Id: string;
  buId: string;
  /** The bullets' dimension (sent only without a filter). */
  groupBy: TrackingGroupBy;
}

export const DEFAULT_CONTROLS: TrackingControls = {
  period: 'ytd', month: '', fiscalYear: null, quarter: 1, from: '', to: '',
  versionId: '', versionFy: null, cc1Id: '', cc2Id: '', buId: '', groupBy: 'cc1',
};

export const PERIOD_LABEL: Record<TrackingPeriod, string> = {
  month: 'Month', quarter: 'Quarter', ytd: 'Year to date', fy: 'Full year', custom: 'Custom',
};

const usesYear = (p: TrackingPeriod) => p === 'quarter' || p === 'ytd' || p === 'fy';

export const hasDimensionFilter = (c: TrackingControls) => c.cc1Id !== '' || c.cc2Id !== '' || c.buId !== '';

const monthOrdinal = (key: string) => Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1;

/** How many months a registry year has, read off its dates (1-15). */
export function yearMonthCount(y: Pick<ReportYearOption, 'startDate' | 'endDate'>): number {
  return monthOrdinal(y.endDate.slice(0, 7)) - monthOrdinal(y.startDate.slice(0, 7)) + 1;
}

/** The quarters of a year: 3-month blocks from its start; the last is short in a 14- or 7-month year. */
export function quarterOptions(y: Pick<ReportYearOption, 'startDate' | 'endDate'> | undefined): Array<{ value: number; label: string }> {
  const months = y ? yearMonthCount(y) : 12;
  const out: Array<{ value: number; label: string }> = [];
  for (let n = 1; 3 * (n - 1) < months; n++) {
    const len = Math.min(3, months - 3 * (n - 1));
    out.push({ value: n, label: len === 3 ? `Q${n}` : `Q${n} (${len} month${len === 1 ? '' : 's'})` });
  }
  return out;
}

/** The label of the registry year holding the month ('YYYY-MM'), or null when no listed year holds it. */
export function yearOfMonth(month: string, years: readonly ReportYearOption[]): number | null {
  const hit = years.find((y) => y.startDate.slice(0, 7) <= month && month <= y.endDate.slice(0, 7));
  return hit ? hit.fiscalYear : null;
}

/**
 * The financial years the window the controls describe would touch: FY* (the
 * year holding its end) and whether it reaches another year. `today` is the
 * month holding today ('YYYY-MM'); `currentFy` the year holding it. Null FY*
 * when the year list cannot tell.
 */
export function controlsWindowYear(
  c: TrackingControls, years: readonly ReportYearOption[], today: string, currentFy: number | null,
): { fy: number | null; crossYear: boolean } {
  if (usesYear(c.period)) return { fy: c.fiscalYear ?? currentFy, crossYear: false };
  if (c.period === 'month') return { fy: yearOfMonth(c.month || today, years), crossYear: false };
  const fy = yearOfMonth(c.to, years);
  const first = yearOfMonth(c.from, years);
  return { fy, crossYear: first !== fy };
}

/** The chosen version, when it may be sent for this window: the window lies in the version's year. */
export function versionApplies(c: TrackingControls, w: { fy: number | null; crossYear: boolean }): boolean {
  return c.versionId !== '' && !w.crossYear && w.fy !== null && w.fy === c.versionFy;
}

/** The report's query string: the period, its own parameters, the version when it applies, the filter. */
export function trackingSearch(c: TrackingControls, opts: { sendVersion: boolean; bullets: boolean }): URLSearchParams {
  const q = new URLSearchParams({ period: c.period });
  if (c.period === 'month' && c.month) q.set('month', c.month);
  if (usesYear(c.period) && c.fiscalYear !== null) q.set('fiscal_year', String(c.fiscalYear));
  if (c.period === 'quarter') q.set('quarter', String(c.quarter));
  if (c.period === 'custom') { q.set('from', c.from); q.set('to', c.to); }
  if (opts.sendVersion) q.set('version_id', c.versionId);
  if (c.cc1Id) q.set('cc1_id', c.cc1Id);
  if (c.cc2Id) q.set('cc2_id', c.cc2Id);
  if (c.buId) q.set('bu_id', c.buId);
  if (opts.bullets && !hasDimensionFilter(c)) q.set('group_by', c.groupBy);
  return q;
}

/** The sentence a cross-year window gives the disabled version picker. */
export function crossYearReason(fys: readonly number[]): string {
  return `This window spans ${fys.map((y) => `FY${y}`).join(' and ')}: each year reads its own primary version.`;
}
