/**
 * Admin Revenue Intelligence Service
 * Plan breakdown, churn trend, NRR, ARPU, LTV, cohort retention. Every revenue
 * figure comes from the metrics module (metrics/metricsSql.ts +
 * revenueMath.ts / timeSeriesMath.ts), the one MRR definition (goal §2a).
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { RevenueIntelligence, ChurnTrendPoint } from '../types/admin.types';
import { loadCohortCompanies, loadSubscriptionFacts } from './metrics/metricsSql';
import {
  averageChurnRate, ltvEstimateCents, netRevenueRetention, planBreakdown, summariseRevenue,
} from './metrics/revenueMath';
import { cohortRetention, sastMonthStartFrom } from './metrics/timeSeriesMath';

type Row = DbRow;

const COHORT_MONTHS = 6;

export async function getRevenueIntelligence(now = new Date()): Promise<RevenueIntelligence> {
  const [facts, churnTrend, cohortCompanies] = await Promise.all([
    loadSubscriptionFacts(),
    getChurnTrend(),
    loadCohortCompanies(sastMonthStartFrom(now, -(COHORT_MONTHS - 1))),
  ]);

  const revenue = summariseRevenue(facts);
  // NRR over last month and this month so far: the companies paying when last month began.
  const nrr = netRevenueRetention(facts, sastMonthStartFrom(now, -1), now);
  const avgChurnRate = averageChurnRate(churnTrend);
  const planRows = planBreakdown(facts);

  log.info('Revenue intelligence fetched', {
    plan_rows: planRows.length,
    churn_months: churnTrend.length,
    nrr,
    arpu_cents: revenue.arpu_cents,
  }, 'revenueService');

  return {
    plan_breakdown: planRows,
    churn_trend: churnTrend,
    nrr,
    arpu_cents: revenue.arpu_cents,
    ltv_estimate_cents: ltvEstimateCents(revenue.arpu_cents, avgChurnRate),
    cohort_retention: cohortRetention(cohortCompanies, facts, now, COHORT_MONTHS),
  };
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
      -- No company active at the start: no rate (NULL), not 0%.
      CASE
        WHEN a.active_count > 0
        THEN ROUND((COALESCE(c.churned_count, 0)::numeric / a.active_count) * 10000) / 100
      END::float AS churn_rate_pct
    FROM active_at_start a
    LEFT JOIN churned c ON c.month_start = a.month_start
    ORDER BY a.month_start ASC
  `;

  return (rows as Row[]).map((row) => ({
    month: row.month as string,
    churned_companies: parseInt(row.churned_companies as string, 10) || 0,
    churn_rate_pct: row.churn_rate_pct == null ? null : Number(row.churn_rate_pct),
  }));
}
