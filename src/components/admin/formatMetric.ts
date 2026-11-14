/**
 * Display helpers for admin metrics: a rate or amount the API sends as null
 * (zero denominator, nobody paying, a month not yet ended) shows a dash, never
 * 0% or R0 (admin audit 2.8).
 */
import { formatCurrency } from '@/utils/formatters';

export const NO_VALUE = '—';

export function formatRate(pct: number | null | undefined, digits?: number): string {
  if (pct == null) return NO_VALUE;
  return `${digits === undefined ? pct : pct.toFixed(digits)}%`;
}

export function formatCentsOrDash(cents: number | null | undefined): string {
  return cents == null ? NO_VALUE : formatCurrency(cents / 100);
}

/** What every MRR/ARR figure counts (goal §2a), shown beside the figure. */
export const MRR_SCOPE_NOTE = 'Active subscriptions only; excludes trials, past due, suspended and internal companies';

/**
 * How MRR history (trend, NRR, churn) is dated, and its approximations
 * (metricsSql.ts loadSubscriptionFacts; revenueMath.ts inMrrAt).
 */
export const MRR_TREND_NOTE = 'History: a converted trial counts from its recorded admin conversion. A conversion with no record '
  + '(a status edit, a self-serve upgrade) counts from the trial end, so a paid subscription bought during a trial, or a trial '
  + 'that was extended, is dated to the current trial end. Past due and paused subscriptions are outside the MRR history '
  + 'and the churn base.';
