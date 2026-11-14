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

/** The MRR trend's one approximation (metricsSql.ts loadSubscriptionFacts). */
export const MRR_TREND_NOTE = 'A converted trial counts from its recorded conversion, or from its trial end when none was recorded.';
