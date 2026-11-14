/**
 * Admin Analytics Trends Service
 * 30-day daily time-series: MRR, engagement (DAU/WAU/MAU), and new signups.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { loadSubscriptionFacts } from './metrics/metricsSql';
import { mrrTrend } from './metrics/timeSeriesMath';
import type {
  AnalyticsTrends,
  MrrTrendPoint,
  EngagementTrendPoint,
  SignupTrendPoint,
} from '../types/admin.types';

type Row = DbRow;

export async function getTrends(): Promise<AnalyticsTrends> {
  const [mrrTrend, engagementTrend, signupTrend] = await Promise.all([
    getMrrTrend(),
    getEngagementTrend(),
    getSignupTrend(),
  ]);

  log.info('Analytics trends fetched', {
    mrr_points: mrrTrend.length,
    engagement_points: engagementTrend.length,
    signup_points: signupTrend.length,
  }, 'trendsService');

  return { mrr_trend: mrrTrend, engagement_trend: engagementTrend, signup_trend: signupTrend };
}

/** 30 SAST days of MRR by the one definition; the last point is today's headline MRR. */
async function getMrrTrend(): Promise<MrrTrendPoint[]> {
  return mrrTrend(await loadSubscriptionFacts(), new Date(), 30);
}

async function getEngagementTrend(): Promise<EngagementTrendPoint[]> {
  const rows = await sql`
    SELECT
      d.date::date::text AS date,
      COUNT(*) FILTER (
        WHERE u.last_login::date = d.date::date
      )::int AS dau,
      COUNT(*) FILTER (
        WHERE u.last_login::date BETWEEN (d.date::date - INTERVAL '6 days')::date AND d.date::date
      )::int AS wau,
      COUNT(*) FILTER (
        WHERE u.last_login::date BETWEEN (d.date::date - INTERVAL '29 days')::date AND d.date::date
      )::int AS mau
    FROM generate_series(
      NOW() - INTERVAL '29 days',
      NOW(),
      INTERVAL '1 day'
    ) AS d(date)
    CROSS JOIN users u
    WHERE u.is_active = true
    GROUP BY d.date
    ORDER BY d.date ASC
  `;
  return (rows as Row[]).map((row) => ({
    date: row.date as string,
    dau: parseInt(row.dau as string, 10) || 0,
    wau: parseInt(row.wau as string, 10) || 0,
    mau: parseInt(row.mau as string, 10) || 0,
  }));
}

async function getSignupTrend(): Promise<SignupTrendPoint[]> {
  const rows = await sql`
    SELECT
      d.date::date::text AS date,
      COUNT(DISTINCT c.id)::int AS new_companies,
      COUNT(DISTINCT u.id)::int AS new_users
    FROM generate_series(
      NOW() - INTERVAL '29 days',
      NOW(),
      INTERVAL '1 day'
    ) AS d(date)
    LEFT JOIN companies c
      ON c.created_at::date = d.date::date
      AND c.status IS DISTINCT FROM 'deleted'
    LEFT JOIN users u
      ON u.created_at::date = d.date::date
      AND u.is_active = true
    GROUP BY d.date
    ORDER BY d.date ASC
  `;
  return (rows as Row[]).map((row) => ({
    date: row.date as string,
    new_companies: parseInt(row.new_companies as string, 10) || 0,
    new_users: parseInt(row.new_users as string, 10) || 0,
  }));
}
