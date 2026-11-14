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
