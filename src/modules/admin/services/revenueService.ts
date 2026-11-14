/**
 * Admin Revenue Intelligence Service
 * Plan breakdown, churn trend, NRR, ARPU, LTV, cohort retention. Every revenue
 * figure comes from the metrics module (metrics/metricsSql.ts +
 * revenueMath.ts / timeSeriesMath.ts), the one MRR definition (goal §2a).
 */

import { log } from '@/lib/logger';
import type { RevenueIntelligence } from '../types/admin.types';
import { loadCohortCompanies, loadSubscriptionFacts } from './metrics/metricsSql';
import {
  averageChurnRate, ltvEstimateCents, netRevenueRetention, planBreakdown, summariseRevenue,
} from './metrics/revenueMath';
import { churnTrend, cohortRetention, sastMonthStartFrom } from './metrics/timeSeriesMath';

const COHORT_MONTHS = 6;

export async function getRevenueIntelligence(now = new Date()): Promise<RevenueIntelligence> {
  const [facts, cohortCompanies] = await Promise.all([
    loadSubscriptionFacts(),
    loadCohortCompanies(sastMonthStartFrom(now, -(COHORT_MONTHS - 1))),
  ]);

  const revenue = summariseRevenue(facts);
  // NRR over last month and this month so far: the companies paying when last month began.
  const nrr = netRevenueRetention(facts, sastMonthStartFrom(now, -1), now);
  // Company churn of the paying population ARPU is taken over, so LTV is one definition.
  const churn = churnTrend(facts, now, COHORT_MONTHS);
  const avgChurnRate = averageChurnRate(churn);
  const planRows = planBreakdown(facts);

  log.info('Revenue intelligence fetched', {
    plan_rows: planRows.length,
    churn_months: churn.length,
    nrr,
    arpu_cents: revenue.arpu_cents,
  }, 'revenueService');

  return {
    plan_breakdown: planRows,
    churn_trend: churn,
    nrr,
    arpu_cents: revenue.arpu_cents,
    ltv_estimate_cents: ltvEstimateCents(revenue.arpu_cents, avgChurnRate),
    cohort_retention: cohortRetention(cohortCompanies, facts, now, COHORT_MONTHS),
  };
}
