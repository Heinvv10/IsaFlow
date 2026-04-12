/**
 * Admin Revenue Intelligence Service
 * Plan breakdown, churn trend, NRR, ARPU, LTV, cohort retention.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type {
  RevenueIntelligence,
  PlanBreakdownRow,
  ChurnTrendPoint,
  CohortRetentionRow,
} from '../types/admin.types';

type Row = DbRow;

export async function getRevenueIntelligence(): Promise<RevenueIntelligence> {
  const [planBreakdown, churnTrend, nrrData, cohortRetention] = await Promise.all([
    getPlanBreakdown(),
    getChurnTrend(),
    getNrrAndArpu(),
    getCohortRetention(),
  ]);

  const avgChurnRate =
    churnTrend.length > 0
      ? churnTrend.reduce((sum, p) => sum + p.churn_rate_pct, 0) / churnTrend.length
      : 0;

  const ltvEstimateCents =
    avgChurnRate > 0 ? Math.round(nrrData.arpu_cents / (avgChurnRate / 100)) : 0;

  log.info('Revenue intelligence fetched', {
    plan_rows: planBreakdown.length,
    churn_months: churnTrend.length,
    nrr: nrrData.nrr,
    arpu_cents: nrrData.arpu_cents,
  }, 'revenueService');

  return {
    plan_breakdown: planBreakdown,
    churn_trend: churnTrend,
    nrr: nrrData.nrr,
    arpu_cents: nrrData.arpu_cents,
    ltv_estimate_cents: ltvEstimateCents,
    cohort_retention: cohortRetention,
  };
}

async function getPlanBreakdown(): Promise<PlanBreakdownRow[]> {
  const rows = await sql`
    SELECT
      p.name                                        AS plan_name,
      s.billing_cycle,
      COUNT(s.id)::int                              AS company_count,
      COALESCE(SUM(
        CASE
          WHEN s.billing_cycle = 'monthly' THEN p.monthly_price_cents
          WHEN s.billing_cycle = 'annual'  THEN ROUND(p.annual_price_cents / 12.0)
          ELSE 0
        END
      ), 0)::int                                    AS mrr_cents,
      COALESCE(SUM(
        CASE
          WHEN s.billing_cycle = 'monthly' THEN p.monthly_price_cents * 12
          WHEN s.billing_cycle = 'annual'  THEN p.annual_price_cents
          ELSE 0
        END
      ), 0)::int                                    AS arr_cents
    FROM plans p
    LEFT JOIN subscriptions s
      ON s.plan_id = p.id
      AND s.status IN ('active', 'trial')
    GROUP BY p.id, p.name, s.billing_cycle
    ORDER BY mrr_cents DESC
  `;

  const totalMrr = (rows as Row[]).reduce(
    (sum, r) => sum + (parseInt(r.mrr_cents as string, 10) || 0),
    0,
  );

  return (rows as Row[]).map((row) => {
    const mrr = parseInt(row.mrr_cents as string, 10) || 0;
    return {
      plan_name: row.plan_name as string,
      billing_cycle: (row.billing_cycle as string) ?? 'monthly',
      company_count: parseInt(row.company_count as string, 10) || 0,
      mrr_cents: mrr,
      arr_cents: parseInt(row.arr_cents as string, 10) || 0,
      pct_of_total: totalMrr > 0 ? Math.round((mrr / totalMrr) * 10000) / 100 : 0,
    };
  });
}

async function getChurnTrend(): Promise<ChurnTrendPoint[]> {
  // Count companies that cancelled each month vs active at start of month.
  const rows = await sql`
    WITH months AS (
      SELECT generate_series(
        date_trunc('month', NOW()) - INTERVAL '5 months',
        date_trunc('month', NOW()),
        INTERVAL '1 month'
      ) AS month_start
    ),
    active_at_start AS (
      SELECT
        m.month_start,
        COUNT(DISTINCT s.company_id) AS active_count
      FROM months m
      LEFT JOIN subscriptions s
        ON s.status IN ('active', 'trial', 'cancelled')
        AND s.created_at < m.month_start
        AND (s.cancelled_at IS NULL OR s.cancelled_at >= m.month_start)
      GROUP BY m.month_start
    ),
    churned AS (
      SELECT
        m.month_start,
        COUNT(DISTINCT s.company_id) AS churned_count
      FROM months m
      LEFT JOIN subscriptions s
        ON s.cancelled_at >= m.month_start
        AND s.cancelled_at < m.month_start + INTERVAL '1 month'
      GROUP BY m.month_start
    )
    SELECT
      a.month_start::date::text AS month,
      COALESCE(c.churned_count, 0)::int AS churned_companies,
      CASE
        WHEN a.active_count > 0
        THEN ROUND((COALESCE(c.churned_count, 0)::numeric / a.active_count) * 10000) / 100
        ELSE 0
      END::float AS churn_rate_pct
    FROM active_at_start a
    LEFT JOIN churned c ON c.month_start = a.month_start
    ORDER BY a.month_start ASC
  `;

  return (rows as Row[]).map((row) => ({
    month: row.month as string,
    churned_companies: parseInt(row.churned_companies as string, 10) || 0,
    churn_rate_pct: parseFloat(row.churn_rate_pct as string) || 0,
  }));
}

async function getNrrAndArpu(): Promise<{ nrr: number; arpu_cents: number }> {
  // NRR: MRR this month from companies that were also active last month / MRR last month from same cohort
  const rows = await sql`
    WITH this_month_cohort AS (
      SELECT
        s.company_id,
        CASE
          WHEN s.billing_cycle = 'monthly' THEN p.monthly_price_cents
          WHEN s.billing_cycle = 'annual'  THEN ROUND(p.annual_price_cents / 12.0)
          ELSE 0
        END AS mrr_cents
      FROM subscriptions s
      JOIN plans p ON p.id = s.plan_id
      WHERE s.status IN ('active', 'trial')
        AND s.created_at < date_trunc('month', NOW())
    ),
    last_month_cohort AS (
      SELECT
        s.company_id,
        CASE
          WHEN s.billing_cycle = 'monthly' THEN p.monthly_price_cents
          WHEN s.billing_cycle = 'annual'  THEN ROUND(p.annual_price_cents / 12.0)
          ELSE 0
        END AS mrr_cents
      FROM subscriptions s
      JOIN plans p ON p.id = s.plan_id
      WHERE s.status IN ('active', 'trial', 'cancelled')
        AND s.created_at < date_trunc('month', NOW()) - INTERVAL '1 month'
        AND (s.cancelled_at IS NULL OR
             s.cancelled_at >= date_trunc('month', NOW()) - INTERVAL '1 month')
    ),
    current_active AS (
      SELECT
        COUNT(DISTINCT s.company_id) AS active_count,
        COALESCE(SUM(
          CASE
            WHEN s.billing_cycle = 'monthly' THEN p.monthly_price_cents
            WHEN s.billing_cycle = 'annual'  THEN ROUND(p.annual_price_cents / 12.0)
            ELSE 0
          END
        ), 0)::int AS total_mrr
      FROM subscriptions s
      JOIN plans p ON p.id = s.plan_id
      WHERE s.status IN ('active', 'trial')
    )
    SELECT
      COALESCE(SUM(t.mrr_cents), 0)::int AS this_mrr,
      COALESCE(SUM(l.mrr_cents), 0)::int AS last_mrr,
      ca.active_count,
      ca.total_mrr
    FROM this_month_cohort t
    FULL OUTER JOIN last_month_cohort l ON l.company_id = t.company_id
    CROSS JOIN current_active ca
    GROUP BY ca.active_count, ca.total_mrr
  `;

  if (!rows || rows.length === 0) {
    return { nrr: 100, arpu_cents: 0 };
  }

  const row = rows[0] as Row;
  const thisMrr = parseInt(row.this_mrr as string, 10) || 0;
  const lastMrr = parseInt(row.last_mrr as string, 10) || 0;
  const activeCount = parseInt(row.active_count as string, 10) || 1;
  const totalMrr = parseInt(row.total_mrr as string, 10) || 0;

  const nrr = lastMrr > 0 ? Math.round((thisMrr / lastMrr) * 10000) / 100 : 100;
  const arpuCents = activeCount > 0 ? Math.round(totalMrr / activeCount) : 0;

  return { nrr, arpu_cents: arpuCents };
}

async function getCohortRetention(): Promise<CohortRetentionRow[]> {
  // Last 6 signup cohorts: % still active at M0, M1, M2, M3
  const rows = await sql`
    WITH cohorts AS (
      SELECT
        date_trunc('month', c.created_at)::date AS cohort_month,
        c.id AS company_id
      FROM companies c
      WHERE c.created_at >= NOW() - INTERVAL '6 months'
        AND c.status IS DISTINCT FROM 'deleted'
    ),
    cohort_sizes AS (
      SELECT cohort_month, COUNT(*) AS cohort_size
      FROM cohorts
      GROUP BY cohort_month
    ),
    retention AS (
      SELECT
        co.cohort_month,
        COUNT(*) FILTER (WHERE
          EXISTS (
            SELECT 1 FROM subscriptions s
            WHERE s.company_id = co.company_id
              AND s.status IN ('active', 'trial')
              AND s.created_at::date <= (co.cohort_month + INTERVAL '0 months')::date
          )
        ) AS m0_active,
        COUNT(*) FILTER (WHERE
          EXISTS (
            SELECT 1 FROM subscriptions s
            WHERE s.company_id = co.company_id
              AND s.status IN ('active', 'trial')
              AND s.created_at::date <= (co.cohort_month + INTERVAL '1 month')::date
              AND (s.cancelled_at IS NULL OR
                   s.cancelled_at > (co.cohort_month + INTERVAL '1 month')::date)
          )
        ) AS m1_active,
        COUNT(*) FILTER (WHERE
          EXISTS (
            SELECT 1 FROM subscriptions s
            WHERE s.company_id = co.company_id
              AND s.status IN ('active', 'trial')
              AND s.created_at::date <= (co.cohort_month + INTERVAL '2 months')::date
              AND (s.cancelled_at IS NULL OR
                   s.cancelled_at > (co.cohort_month + INTERVAL '2 months')::date)
          )
        ) AS m2_active,
        COUNT(*) FILTER (WHERE
          EXISTS (
            SELECT 1 FROM subscriptions s
            WHERE s.company_id = co.company_id
              AND s.status IN ('active', 'trial')
              AND s.created_at::date <= (co.cohort_month + INTERVAL '3 months')::date
              AND (s.cancelled_at IS NULL OR
                   s.cancelled_at > (co.cohort_month + INTERVAL '3 months')::date)
          )
        ) AS m3_active
      FROM cohorts co
      GROUP BY co.cohort_month
    )
    SELECT
      r.cohort_month::text,
      cs.cohort_size::int,
      ROUND((r.m0_active::numeric / NULLIF(cs.cohort_size, 0)) * 100, 1)::float AS m0_pct,
      ROUND((r.m1_active::numeric / NULLIF(cs.cohort_size, 0)) * 100, 1)::float AS m1_pct,
      ROUND((r.m2_active::numeric / NULLIF(cs.cohort_size, 0)) * 100, 1)::float AS m2_pct,
      ROUND((r.m3_active::numeric / NULLIF(cs.cohort_size, 0)) * 100, 1)::float AS m3_pct
    FROM retention r
    JOIN cohort_sizes cs ON cs.cohort_month = r.cohort_month
    ORDER BY r.cohort_month ASC
  `;

  return (rows as Row[]).map((row) => ({
    cohort_month: row.cohort_month as string,
    cohort_size: parseInt(row.cohort_size as string, 10) || 0,
    m0_pct: parseFloat(row.m0_pct as string) || 0,
    m1_pct: parseFloat(row.m1_pct as string) || 0,
    m2_pct: parseFloat(row.m2_pct as string) || 0,
    m3_pct: parseFloat(row.m3_pct as string) || 0,
  }));
}
