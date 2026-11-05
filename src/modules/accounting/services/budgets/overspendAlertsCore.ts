/**
 * Overspend alerts, the pure rules (budgets P5 spec §3d, decision 9). No I/O: `overspendAlerts.ts`
 * reads the figures through remaining budget's readers and decides with these.
 *
 * - Percentage: (actual + committed) / budget × 100, in cents. A budget of zero (or below) with spend
 *   above zero is INFINITE: every threshold is crossed (any spend against R0 is past 80 % of it). With
 *   no spend it is 0. A key with no budget (null, "No budget") never alerts.
 * - Thresholds for a key, most specific first: an override for the account AND the key's slice, an
 *   override for the account alone (all dimensions null), the company's `default_thresholds`, then
 *   80 / 100 / 120.
 * - A threshold `t` is crossed when `t ≤ pct`.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { toCents } from './grid/cents';

export const DEFAULT_THRESHOLDS: readonly number[] = [80, 100, 120];

/** The API's bounds on a threshold list (the table allows up to 10 values in (0, 1000]). */
export const MAX_THRESHOLDS = 5;
export const THRESHOLD_MIN = 1;
export const THRESHOLD_MAX = 999;

export interface SliceDims {
  cc1Id: string | null;
  cc2Id: string | null;
  buId: string | null;
}

export interface AlertKey extends SliceDims {
  glAccountId: string;
  /** 'YYYY-MM'. */
  month: string;
}

export interface AlertKeyFigures extends AlertKey {
  /** Null: no budget for the key (never alerts). */
  budget: number | null;
  actual: number;
  committed: number;
}

export interface ThresholdOverride extends SliceDims {
  glAccountId: string;
  thresholds: readonly number[];
}

export interface Crossing extends AlertKeyFigures {
  budget: number;
  threshold: number;
  /** Infinity for spend against a zero budget. */
  pct: number;
}

/** Sorted ascending, duplicates dropped. */
export function normaliseThresholds(values: readonly number[]): number[] {
  return [...new Set(values.map(Number))].sort((a, b) => a - b);
}

/** (actual + committed) / budget × 100, rounded to 4 places; Infinity for spend against a budget ≤ 0. */
export function overspendPct(budget: number, actual: number, committed: number): number {
  const spend = toCents(actual) + toCents(committed);
  const base = toCents(budget);
  if (base <= 0) return spend > 0 ? Infinity : 0;
  return Math.round((spend * 100 * 10_000) / base) / 10_000;
}

const low = (v: string | null): string | null => (v == null ? null : v.toLowerCase());
const sameSlice = (a: SliceDims, b: SliceDims): boolean =>
  low(a.cc1Id) === low(b.cc1Id) && low(a.cc2Id) === low(b.cc2Id) && low(a.buId) === low(b.buId);
const NO_DIMS: SliceDims = { cc1Id: null, cc2Id: null, buId: null };

export function thresholdsFor(
  key: AlertKey, overrides: readonly ThresholdOverride[], companyDefault: readonly number[] | null,
): number[] {
  const acct = key.glAccountId.toLowerCase();
  const mine = overrides.filter((o) => o.glAccountId.toLowerCase() === acct);
  const exact = mine.find((o) => sameSlice(o, key));
  const whole = mine.find((o) => sameSlice(o, NO_DIMS));
  const chosen = exact ?? whole;
  if (chosen) return normaliseThresholds(chosen.thresholds);
  return normaliseThresholds(companyDefault && companyDefault.length > 0 ? companyDefault : DEFAULT_THRESHOLDS);
}

/** Every (key, threshold) crossed: `t ≤ pct`. */
export function crossingsOf(keys: readonly AlertKeyFigures[], thresholdsOf: (k: AlertKey) => readonly number[]): Crossing[] {
  const out: Crossing[] = [];
  for (const k of keys) {
    if (k.budget === null) continue;
    const pct = overspendPct(k.budget, k.actual, k.committed);
    for (const t of thresholdsOf(k)) {
      if (t <= pct) out.push({ ...k, budget: k.budget, threshold: t, pct });
    }
  }
  return out;
}

/**
 * One run notifies at most this many alerts per user; above it, one summary instead (spec §10 "alerts
 * noisy": the first run over a year already overspent).
 */
export const MAX_ALERT_NOTIFICATIONS_PER_RUN = 10;

/** Per key (account, slice, month), only the alert with the highest threshold; input order kept. */
export function highestPerKey<T extends AlertKey & { threshold: number }>(alerts: readonly T[]): T[] {
  const key = (a: T) => [a.glAccountId, a.cc1Id, a.cc2Id, a.buId, a.month].map((v) => (v ?? '').toLowerCase()).join('|');
  const best = new Map<string, T>();
  for (const a of alerts) {
    const k = key(a);
    const held = best.get(k);
    if (!held || a.threshold > held.threshold) best.set(k, a);
  }
  const keep = new Set(best.values());
  return alerts.filter((a) => keep.has(a));
}

/** Budget vs Actual on the alert's month, filtered to its slice (the report has no account filter). */
export function alertHref(k: Pick<AlertKey, 'month' | 'cc1Id' | 'cc2Id' | 'buId'>): string {
  const q = new URLSearchParams({ period: 'month', month: k.month });
  if (k.cc1Id) q.set('cc1_id', k.cc1Id);
  if (k.cc2Id) q.set('cc2_id', k.cc2Id);
  if (k.buId) q.set('bu_id', k.buId);
  return `/accounting/reports/budget-vs-actual?${q.toString()}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'Apr 2026' for '2026-04'. */
export function monthName(month: string): string {
  return `${MONTHS[Number(month.slice(5, 7)) - 1] ?? month.slice(5, 7)} ${month.slice(0, 4)}`;
}

/** The app's one money format ('R 1 234.50', non-breaking spaces; `@/lib/money/formatMoney`), in cents. */
export function rand(amount: number): string {
  return formatMoney(toCents(amount) / 100);
}

/** '112.5%', or 'spent against a zero budget' for an infinite percentage. */
export function pctText(pct: number): string {
  if (!Number.isFinite(pct)) return 'spent against a zero budget';
  return `${Math.round(pct * 10) / 10}%`;
}
