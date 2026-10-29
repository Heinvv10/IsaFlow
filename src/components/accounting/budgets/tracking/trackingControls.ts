/**
 * The Budget vs Actual page's controls, the query string they send (budgets P3
 * spec §2.2, §2.5, §4), and the same controls in the page URL, so Back and a
 * shared link land on the same report. Pure: no fetch, no Date read for a month.
 *
 * Only the parameters that apply to the period are sent; the route refuses
 * the others with a 400 (`trackingWindow.assertParamsApply`):
 *   month    → month (when chosen)
 *   quarter  → fiscal_year (when chosen) + quarter
 *   ytd, fy  → fiscal_year (when chosen)
 *   custom   → from + to
 * A version belongs to one financial year, so choosing another window returns
 * to each year's primary (`withPatch`); whether the window spans two years is
 * the engine's answer (`versionsByFy` on the response), never re-derived here.
 * `group_by` (the bullets) is sent only without a dimension filter: the route
 * refuses the two together.
 */
import { UUID_RE } from '@/lib/validation';
import type { TrackingGroupBy, TrackingPeriod } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import type { ReportYearOption } from '@/modules/accounting/services/reports/budgetReportYear';

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
  cc1Id: string;
  cc2Id: string;
  buId: string;
  /** The bullets' dimension (sent only without a filter). */
  groupBy: TrackingGroupBy;
}

export const DEFAULT_CONTROLS: TrackingControls = {
  period: 'ytd', month: '', fiscalYear: null, quarter: 1, from: '', to: '',
  versionId: '', cc1Id: '', cc2Id: '', buId: '', groupBy: 'cc1',
};

export const PERIOD_LABEL: Record<TrackingPeriod, string> = {
  month: 'Month', quarter: 'Quarter', ytd: 'Year to date', fy: 'Full year', custom: 'Custom',
};

const WINDOW_KEYS: ReadonlyArray<keyof TrackingControls> = ['period', 'month', 'fiscalYear', 'quarter', 'from', 'to'];
const GROUPS: readonly TrackingGroupBy[] = ['cc1', 'cc2', 'bu'];

const usesYear = (p: TrackingPeriod) => p === 'quarter' || p === 'ytd' || p === 'fy';

export const hasDimensionFilter = (c: TrackingControls) => c.cc1Id !== '' || c.cc2Id !== '' || c.buId !== '';

/** The controls after a change: another window drops the chosen version (it belongs to one year). */
export function withPatch(c: TrackingControls, patch: Partial<TrackingControls>): TrackingControls {
  const next = { ...c, ...patch };
  const windowMoved = WINDOW_KEYS.some((k) => k in patch && patch[k] !== c[k]);
  return windowMoved && !('versionId' in patch) ? { ...next, versionId: '' } : next;
}

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

/**
 * The quarter a Quarter view opens on: the one holding today ('YYYY-MM') when the year holds it, as
 * Month opens on the month holding today; Q1 for a year that does not (past or future).
 */
export function quarterHolding(y: Pick<ReportYearOption, 'startDate' | 'endDate'> | undefined, today: string): number {
  if (!y || today < y.startDate.slice(0, 7) || today > y.endDate.slice(0, 7)) return 1;
  return Math.floor((monthOrdinal(today) - monthOrdinal(y.startDate.slice(0, 7))) / 3) + 1;
}

/** Why the controls cannot be sent as they stand (checked before any request), or null. */
export function controlsProblem(c: TrackingControls): string | null {
  return c.period === 'custom' && c.from && c.to && c.from > c.to ? 'The From month is after the To month.' : null;
}

/** The report's query string: the period, its own parameters, the version, the filter, the bullets. */
export function trackingSearch(c: TrackingControls, opts: { bullets: boolean }): URLSearchParams {
  const q = new URLSearchParams({ period: c.period });
  if (c.period === 'month' && c.month) q.set('month', c.month);
  if (usesYear(c.period) && c.fiscalYear !== null) q.set('fiscal_year', String(c.fiscalYear));
  if (c.period === 'quarter') q.set('quarter', String(c.quarter));
  if (c.period === 'custom') { q.set('from', c.from); q.set('to', c.to); }
  if (c.versionId) q.set('version_id', c.versionId);
  if (c.cc1Id) q.set('cc1_id', c.cc1Id);
  if (c.cc2Id) q.set('cc2_id', c.cc2Id);
  if (c.buId) q.set('bu_id', c.buId);
  if (opts.bullets && !hasDimensionFilter(c)) q.set('group_by', c.groupBy);
  return q;
}

/** The page URL's query: the report's own parameters, and the bullets' dimension when not the default. */
export function controlsToQuery(c: TrackingControls): Record<string, string> {
  const q = Object.fromEntries(trackingSearch(c, { bullets: false }));
  if (c.groupBy !== DEFAULT_CONTROLS.groupBy) q.group_by = c.groupBy;
  return q;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : '');

/** Controls from the page URL; anything malformed or not this period's is left at its default. */
export function controlsFromQuery(query: Record<string, string | string[] | undefined>): TrackingControls {
  const c: TrackingControls = { ...DEFAULT_CONTROLS };
  const period = one(query.period) as TrackingPeriod;
  if ((Object.keys(PERIOD_LABEL) as TrackingPeriod[]).includes(period)) c.period = period;
  const month = one(query.month), from = one(query.from), to = one(query.to), fy = one(query.fiscal_year), q = one(query.quarter);
  if (c.period === 'month' && MONTH_RE.test(month)) c.month = month;
  if (usesYear(c.period) && /^\d{4}$/.test(fy)) c.fiscalYear = Number(fy);
  if (c.period === 'quarter' && /^[1-5]$/.test(q)) c.quarter = Number(q);
  if (c.period === 'custom') {
    if (!MONTH_RE.test(from) || !MONTH_RE.test(to)) c.period = DEFAULT_CONTROLS.period;
    else { c.from = from; c.to = to; }
  }
  for (const [param, key] of [['version_id', 'versionId'], ['cc1_id', 'cc1Id'], ['cc2_id', 'cc2Id'], ['bu_id', 'buId']] as const) {
    if (UUID_RE.test(one(query[param]))) c[key] = one(query[param]);
  }
  const group = one(query.group_by) as TrackingGroupBy;
  if (GROUPS.includes(group)) c.groupBy = group;
  return c;
}

/** The sentence a cross-year window gives the disabled version picker. */
export function crossYearReason(fys: readonly number[]): string {
  return `This window spans ${fys.map((y) => `FY${y}`).join(' and ')}: each year reads its own primary version.`;
}
