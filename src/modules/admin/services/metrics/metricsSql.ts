/**
 * The admin metrics module's SQL: the one place the subscription amount and the
 * "which companies count" rules are written (admin audit 2.3, goal §2a). Every
 * revenue figure on the admin site reads `loadSubscriptionFacts` (summed in
 * revenueMath.ts) or embeds the fragments below; nothing else prices a
 * subscription.
 *
 * Fragments assume the aliases `s` (subscriptions), `p` (plans) and `c`
 * (companies). They are functions, not constants, so a test that mocks
 * '@/lib/neon' is not handed a query built at import time.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { summariseRevenue, type RevenueSummary, type SubscriptionFact } from './revenueMath';
import type { CohortCompany } from './timeSeriesMath';

/**
 * Company `c` is internal or deleted: outside every platform metric. Internal
 * = the Demo tenant 00000000-0000-0000-0000-000000000001 (goal §2a) or any
 * company flagged `is_demo`.
 */
export const companyOutOfMetrics = () => sql`(
  COALESCE(c.status, 'active') = 'deleted'
  OR COALESCE(c.is_demo, false)
  OR c.id = '00000000-0000-0000-0000-000000000001'::uuid)`;

/** Company `c` is outside MRR: internal, deleted or suspended. */
export const companyOutOfMrr = () => sql`(${companyOutOfMetrics()} OR COALESCE(c.status, 'active') = 'suspended')`;

/**
 * Subscription `s` on plan `p`, annualised and discounted, in hundredths of a
 * cent: an exact integer. MRR cents = units / 1200, ARR cents = units / 100.
 */
export const subscriptionAnnualUnits = () => sql`(
  CASE s.billing_cycle
    WHEN 'monthly' THEN p.monthly_price_cents::bigint * 12
    WHEN 'annual'  THEN p.annual_price_cents::bigint
    ELSE 0
  END * (100 - COALESCE(s.discount_percent, 0)))`;

/** Subscription `s` of company `c` is in MRR. */
export const subscriptionInMrr = () => sql`(s.status = 'active' AND NOT ${companyOutOfMrr()})`;

/** The MRR of company `c` (the outer query's alias), rounded once: an int. */
export const companyMrrCents = () => sql`(
  SELECT ROUND(COALESCE(SUM(${subscriptionAnnualUnits()}), 0)::numeric / 1200)::int
  FROM subscriptions s
  JOIN plans p ON p.id = s.plan_id
  WHERE s.company_id = c.id AND ${subscriptionInMrr()})`;

/** One subscription's MRR after discount, rounded: for a per-subscription "Amount". */
export const subscriptionMrrCents = () => sql`ROUND(${subscriptionAnnualUnits()}::numeric / 1200)::int`;

/**
 * LEFT JOIN LATERAL `cur`: company `c`'s current subscription, by the rule the
 * feature-flag readers use (featureFlagService.ts): the latest created of
 * trial / active / past_due. One row per company, so a list never repeats one.
 */
export const currentSubscriptionJoin = () => sql`
  LEFT JOIN LATERAL (
    SELECT s.plan_id, s.billing_cycle
    FROM subscriptions s
    WHERE s.company_id = c.id AND s.status IN ('trial', 'active', 'past_due')
    ORDER BY s.created_at DESC NULLS LAST, s.id DESC
    LIMIT 1
  ) cur ON true`;

const asDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
const asDateOrNull = (v: unknown): Date | null => (v == null ? null : asDate(v));

/**
 * Every subscription with its amount, whether it is in MRR now, and when it
 * started earning (`mrr_from`, for history: trend, NRR, churn). A trial is
 * converted IN PLACE (same row, created at the trial start), so:
 *   - the company's latest `trial.convert_to_paid` admin audit row, when it
 *     has one, is the conversion (a row created after it keeps its created_at);
 *   - else, a row created before the company's trial_ends_at is taken to be
 *     the trial row and earns from the trial end (capped at now). This is an
 *     approximation (a paid row bought during the trial is dated to the trial
 *     end; an extended trial moves it): the trend card says so.
 */
export async function loadSubscriptionFacts(): Promise<SubscriptionFact[]> {
  const rows = await sql`
    SELECT s.id::text AS id, s.company_id::text AS company_id, p.id::text AS plan_id, p.name AS plan_name,
           s.billing_cycle, s.status, s.created_at, s.cancelled_at,
           CASE
             WHEN conv.converted_at IS NOT NULL THEN GREATEST(s.created_at, conv.converted_at)
             WHEN c.trial_ends_at IS NOT NULL AND s.created_at < c.trial_ends_at THEN LEAST(c.trial_ends_at, NOW())
             ELSE s.created_at
           END AS mrr_from,
           ${subscriptionAnnualUnits()} AS annual_units,
           ${subscriptionInMrr()} AS counts_toward_mrr,
           ${companyOutOfMrr()} AS company_excluded
    FROM subscriptions s
    JOIN plans p ON p.id = s.plan_id
    JOIN companies c ON c.id = s.company_id
    LEFT JOIN LATERAL (
      SELECT MAX(a.created_at) AS converted_at
      FROM admin_audit_log a
      WHERE a.action = 'trial.convert_to_paid' AND a.target_type = 'company' AND a.target_id = c.id::text
    ) conv ON true
  `;
  return (rows as DbRow[]).map((r) => ({
    id: r.id as string,
    company_id: r.company_id as string,
    plan_id: r.plan_id as string,
    plan_name: r.plan_name as string,
    billing_cycle: r.billing_cycle as string,
    status: r.status as string,
    created_at: asDate(r.created_at),
    mrr_from: asDate(r.mrr_from),
    cancelled_at: asDateOrNull(r.cancelled_at),
    annual_units: Number(r.annual_units),
    counts_toward_mrr: r.counts_toward_mrr === true,
    company_excluded: r.company_excluded === true,
  }));
}

/** MRR, ARR, ARPU and paying companies now: the headline figures. */
export async function getRevenueSummary(): Promise<RevenueSummary> {
  return summariseRevenue(await loadSubscriptionFacts());
}

/** Companies (not internal, not deleted) that signed up at or after `since`. */
export async function loadCohortCompanies(since: Date): Promise<CohortCompany[]> {
  const rows = await sql`
    SELECT c.id::text AS id, c.created_at, c.trial_ends_at
    FROM companies c
    WHERE c.created_at >= ${since.toISOString()}::timestamptz AND NOT ${companyOutOfMetrics()}
  `;
  return (rows as DbRow[]).map((r) => ({
    id: r.id as string,
    created_at: asDate(r.created_at),
    trial_ends_at: asDateOrNull(r.trial_ends_at),
  }));
}

/** Ids of the companies a platform-wide rate is taken over (not internal, not deleted). */
export async function loadLiveCompanyIds(): Promise<string[]> {
  const rows = await sql`SELECT c.id::text AS id FROM companies c WHERE NOT ${companyOutOfMetrics()}`;
  return (rows as DbRow[]).map((r) => r.id as string);
}
