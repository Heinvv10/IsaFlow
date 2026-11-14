/**
 * Platform revenue arithmetic — pure, no database (admin audit 2.1, 2.3, 2.10).
 *
 * The one definition (Hein, 2026-11-14):
 *   - MRR counts ACTIVE subscriptions only, discount applied, annual price / 12,
 *     and never a deleted or suspended company or the Demo tenant. Trials are
 *     never inside MRR.
 *   - ARR is the sum of the annualised amounts (monthly x 12, or the annual
 *     price), rounded once — not a rounded MRR x 12.
 *   - A paying company has at least one such subscription worth more than R0.
 *     ARPU = MRR / paying companies; no paying company means no ARPU (null).
 *
 * Amounts arrive as `annual_units`: the subscription's annualised price in
 * hundredths of a cent (price x (100 - discount %)), an exact integer that
 * metricsSql.ts computes in one SQL expression. MRR cents = units / 1200 and
 * ARR cents = units / 100, so a sum is exact until the one rounding at the end.
 */

import type { PlanBreakdownRow } from '../../types/admin-billing.types';

export interface SubscriptionFact {
  id: string;
  company_id: string;
  plan_id: string;
  plan_name: string;
  billing_cycle: string;
  status: string;
  created_at: Date;
  cancelled_at: Date | null;
  /** Annualised price after discount, in hundredths of a cent. */
  annual_units: number;
  /** status = 'active' and the company is not excluded (metricsSql.ts). */
  counts_toward_mrr: boolean;
  /** Deleted, suspended or the Demo tenant: outside every revenue figure. */
  company_excluded: boolean;
}

export interface RevenueSummary {
  mrr_cents: number;
  arr_cents: number;
  /** Subscriptions counted in MRR (active, company not excluded), R0 ones included. */
  active_subscriptions: number;
  paying_companies: number;
  /** null when no company pays. */
  arpu_cents: number | null;
}

export const UNITS_PER_MRR_CENT = 1200;
export const UNITS_PER_ARR_CENT = 100;

export const mrrCentsFromUnits = (units: number): number => Math.round(units / UNITS_PER_MRR_CENT);
export const arrCentsFromUnits = (units: number): number => Math.round(units / UNITS_PER_ARR_CENT);

/** num / den as a percentage rounded to `dp` places; null when den is 0 (shown as a dash). */
export function percentOrNull(num: number, den: number, dp = 2): number | null {
  if (!(den > 0)) return null;
  const f = 10 ** dp;
  return Math.round((num / den) * 100 * f) / f;
}

const sumUnits = (facts: readonly SubscriptionFact[]): number =>
  facts.reduce((sum, f) => sum + f.annual_units, 0);

function summarise(live: readonly SubscriptionFact[]): RevenueSummary {
  const units = sumUnits(live);
  const paying = new Set(live.filter((f) => f.annual_units > 0).map((f) => f.company_id)).size;
  return {
    mrr_cents: mrrCentsFromUnits(units),
    arr_cents: arrCentsFromUnits(units),
    active_subscriptions: live.length,
    paying_companies: paying,
    arpu_cents: paying > 0 ? Math.round(units / UNITS_PER_MRR_CENT / paying) : null,
  };
}

/** Today's MRR, ARR, ARPU and paying-company count. */
export function summariseRevenue(facts: readonly SubscriptionFact[]): RevenueSummary {
  return summarise(facts.filter((f) => f.counts_toward_mrr));
}

/**
 * Was this subscription in MRR at instant `at`? There is no status history, so:
 * an active one counts from its creation; a cancelled one counts from creation
 * until its cancelled_at (never, when cancelled_at is missing); any other
 * status (trial, past_due, paused) is not in MRR now and has no knowable past.
 * At `at` = now this is exactly `counts_toward_mrr`.
 */
export function inMrrAt(f: SubscriptionFact, at: Date): boolean {
  if (f.company_excluded || f.created_at.getTime() > at.getTime()) return false;
  if (f.status === 'active') return true;
  if (f.status === 'cancelled') return f.cancelled_at !== null && f.cancelled_at.getTime() > at.getTime();
  return false;
}

export function revenueAt(facts: readonly SubscriptionFact[], at: Date): RevenueSummary {
  return summarise(facts.filter((f) => inMrrAt(f, at)));
}

/** MRR per plan and billing cycle, paying subscriptions only, largest first. */
export function planBreakdown(facts: readonly SubscriptionFact[]): PlanBreakdownRow[] {
  const paying = facts.filter((f) => f.counts_toward_mrr && f.annual_units > 0);
  const totalUnits = sumUnits(paying);
  const groups = new Map<string, SubscriptionFact[]>();
  for (const f of paying) {
    const key = `${f.plan_id}|${f.billing_cycle}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  return [...groups.values()]
    .map((g) => {
      const units = sumUnits(g);
      return {
        plan_name: g[0]!.plan_name,
        billing_cycle: g[0]!.billing_cycle,
        company_count: new Set(g.map((f) => f.company_id)).size,
        mrr_cents: mrrCentsFromUnits(units),
        arr_cents: arrCentsFromUnits(units),
        pct_of_total: percentOrNull(units, totalUnits),
      };
    })
    .sort((a, b) => b.mrr_cents - a.mrr_cents || a.plan_name.localeCompare(b.plan_name));
}

/** MRR and paying companies per plan (both cycles together), largest first. */
export function revenueByPlan(facts: readonly SubscriptionFact[]): Array<{ plan_name: string; mrr_cents: number; company_count: number }> {
  const paying = facts.filter((f) => f.counts_toward_mrr && f.annual_units > 0);
  const groups = new Map<string, SubscriptionFact[]>();
  for (const f of paying) groups.set(f.plan_id, [...(groups.get(f.plan_id) ?? []), f]);
  return [...groups.values()]
    .map((g) => ({
      plan_name: g[0]!.plan_name,
      mrr_cents: mrrCentsFromUnits(sumUnits(g)),
      company_count: new Set(g.map((f) => f.company_id)).size,
    }))
    .sort((a, b) => b.mrr_cents - a.mrr_cents || a.plan_name.localeCompare(b.plan_name));
}

/**
 * Net revenue retention from `start` to `now`, as a percentage (2 dp): the MRR
 * today of the companies that were paying at `start`, over their MRR at
 * `start`. A company that first paid after `start` is a new sale and is in
 * neither side. null when nobody was paying at `start`. Prices are today's
 * (there is no price history).
 */
export function netRevenueRetention(facts: readonly SubscriptionFact[], start: Date, now: Date): number | null {
  const startUnits = new Map<string, number>();
  for (const f of facts) {
    if (inMrrAt(f, start)) startUnits.set(f.company_id, (startUnits.get(f.company_id) ?? 0) + f.annual_units);
  }
  const cohort = new Set([...startUnits].filter(([, units]) => units > 0).map(([company]) => company));
  const before = [...cohort].reduce((sum, company) => sum + startUnits.get(company)!, 0);
  const after = sumUnits(facts.filter((f) => cohort.has(f.company_id) && inMrrAt(f, now)));
  return percentOrNull(after, before);
}

/** Mean of the months that had anyone to churn; null when none did. */
export function averageChurnRate(points: ReadonlyArray<{ churn_rate_pct: number | null }>): number | null {
  const rates = points.map((p) => p.churn_rate_pct).filter((r): r is number => r !== null);
  return rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : null;
}

/** ARPU / monthly churn; null when either is unknown or churn is 0. */
export function ltvEstimateCents(arpuCents: number | null, avgChurnPct: number | null): number | null {
  if (arpuCents === null || avgChurnPct === null || !(avgChurnPct > 0)) return null;
  return Math.round(arpuCents / (avgChurnPct / 100));
}
