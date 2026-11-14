/**
 * Admin Analytics Service
 * Platform health, usage analytics, and settings for IsaFlow Admin Platform.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { PlatformHealth, UsageAnalytics, PlatformSettings } from '../types/admin.types';
import { companiesWithFeature, listFeatureFlags } from './featureFlagService';
import { loadLiveCompanyIds, loadSubscriptionFacts } from './metrics/metricsSql';
import { percentOrNull, revenueByPlan } from './metrics/revenueMath';
export { getTrends } from './trendsService';
type Row = DbRow;


function toISOString(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value as string;
}

export async function getPlatformHealth(): Promise<PlatformHealth> {
  const [activeUsers, apiCalls, dbSize, topCompanies] = await Promise.all([
    getActiveUserCounts(),
    getApiCallCount(),
    getDbSizeMb(),
    getTopCompaniesBySize(),
  ]);

  const health: PlatformHealth = {
    active_users_24h: activeUsers.h24,
    active_users_7d: activeUsers.d7,
    active_users_30d: activeUsers.d30,
    total_api_calls_24h: apiCalls.total,
    error_count_24h: apiCalls.errors,
    error_rate_percent: percentOrNull(apiCalls.errors, apiCalls.total),
    db_size_mb: dbSize,
    top_companies_by_size: topCompanies,
  };

  log.info('Platform health fetched', {
    active_users_24h: health.active_users_24h,
    db_size_mb: health.db_size_mb,
  }, 'analyticsService');

  return health;
}

async function getActiveUserCounts(): Promise<{ h24: number; d7: number; d30: number }> {
  const rows = await sql`
    SELECT
      COUNT(*) FILTER (WHERE last_login >= NOW() - INTERVAL '24 hours') AS h24,
      COUNT(*) FILTER (WHERE last_login >= NOW() - INTERVAL '7 days')   AS d7,
      COUNT(*) FILTER (WHERE last_login >= NOW() - INTERVAL '30 days')  AS d30
    FROM users
    WHERE is_active = true
  `;
  const row = rows[0] as Row;
  return {
    h24: parseInt(row.h24 as string, 10) || 0,
    d7: parseInt(row.d7 as string, 10) || 0,
    d30: parseInt(row.d30 as string, 10) || 0,
  };
}

async function getApiCallCount(): Promise<{ total: number; errors: number }> {
  const rows = await sql`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE action ILIKE 'error%') AS errors
    FROM admin_audit_log
    WHERE created_at >= NOW() - INTERVAL '24 hours'
  `;
  const row = rows[0] as Row;
  return {
    total: parseInt(row.total as string, 10) || 0,
    errors: parseInt(row.errors as string, 10) || 0,
  };
}

async function getDbSizeMb(): Promise<number> {
  const rows = await sql`
    SELECT ROUND(pg_database_size(current_database()) / 1048576.0, 2) AS size_mb
  `;
  const val = (rows[0] as Row).size_mb;
  return parseFloat(val as string) || 0;
}

async function getTopCompaniesBySize(): Promise<PlatformHealth['top_companies_by_size']> {
  // Proxy company "size" by counting rows in major tables grouped by company_id
  const rows = await sql`
    SELECT
      c.id::text AS company_id,
      c.name AS company_name,
      (
        COALESCE((SELECT COUNT(*) FROM gl_journal_entries je WHERE je.company_id = c.id), 0)
        + COALESCE((SELECT COUNT(*) FROM customer_invoices ci WHERE COALESCE(ci.client_id, ci.customer_id) IS NOT NULL AND ci.company_id = c.id), 0)
        + COALESCE((SELECT COUNT(*) FROM bank_transactions bt WHERE bt.company_id = c.id), 0)
      )::float / 1000.0 AS size_mb
    FROM companies c
    WHERE c.status IS DISTINCT FROM 'deleted'
    ORDER BY size_mb DESC
    LIMIT 10
  `;
  return (rows as Row[]).map((row) => ({
    company_id: row.company_id as string,
    company_name: row.company_name as string,
    size_mb: parseFloat(row.size_mb as string) || 0,
  }));
}

export async function getUsageAnalytics(): Promise<UsageAnalytics> {
  const [engagement, featureAdoption, revenueByPlan, churnSignals] = await Promise.all([
    getEngagementCounts(),
    getFeatureAdoption(),
    getRevenueByPlan(),
    getChurnSignals(),
  ]);

  const stickiness = percentOrNull(engagement.dau, engagement.mau);

  const analytics: UsageAnalytics = {
    dau: engagement.dau,
    wau: engagement.wau,
    mau: engagement.mau,
    stickiness_percent: stickiness,
    // top_pages requires a page_views tracking table — not yet implemented
    top_pages: [],
    feature_adoption: featureAdoption,
    revenue_by_plan: revenueByPlan,
    churn_signals: churnSignals,
  };

  log.info('Usage analytics fetched', {
    dau: analytics.dau,
    mau: analytics.mau,
    churn_signals: analytics.churn_signals.length,
  }, 'analyticsService');

  return analytics;
}

async function getEngagementCounts(): Promise<{ dau: number; wau: number; mau: number }> {
  const rows = await sql`
    SELECT
      COUNT(*) FILTER (WHERE last_login >= NOW() - INTERVAL '1 day')   AS dau,
      COUNT(*) FILTER (WHERE last_login >= NOW() - INTERVAL '7 days')  AS wau,
      COUNT(*) FILTER (WHERE last_login >= NOW() - INTERVAL '30 days') AS mau
    FROM users
    WHERE is_active = true
  `;
  const row = rows[0] as Row;
  return {
    dau: parseInt(row.dau as string, 10) || 0,
    wau: parseInt(row.wau as string, 10) || 0,
    mau: parseInt(row.mau as string, 10) || 0,
  };
}

/**
 * Per flag, the live companies (not deleted, not internal) that HAVE the
 * feature: override, else global flag, else their plan — the same reader the
 * feature gate uses (featureFlagService.companiesWithFeature), not overrides alone.
 */
async function getFeatureAdoption(): Promise<UsageAnalytics['feature_adoption']> {
  const [companyIds, flags] = await Promise.all([loadLiveCompanyIds(), listFeatureFlags()]);
  const adoption = await Promise.all(flags.map(async (flag) => {
    const count = (await companiesWithFeature(companyIds, flag.code)).size;
    return { feature: flag.name, user_count: count, adoption_percent: percentOrNull(count, companyIds.length) };
  }));
  return adoption.sort((a, b) => b.user_count - a.user_count || a.feature.localeCompare(b.feature));
}

/** Paying companies and MRR per plan, by the one MRR definition (trials are not a plan's revenue). */
async function getRevenueByPlan(): Promise<UsageAnalytics['revenue_by_plan']> {
  return revenueByPlan(await loadSubscriptionFacts());
}

async function getChurnSignals(): Promise<UsageAnalytics['churn_signals']> {
  const rows = await sql`
    SELECT
      c.id::text AS company_id,
      c.name     AS company_name,
      EXTRACT(DAY FROM NOW() - MAX(u.last_login))::int AS days_inactive,
      MAX(u.last_login) AS last_login
    FROM companies c
    INNER JOIN company_users cu ON cu.company_id = c.id
    INNER JOIN users u ON u.id = cu.user_id AND u.is_active = true
    WHERE c.status IS DISTINCT FROM 'deleted'
    GROUP BY c.id, c.name
    HAVING MAX(u.last_login) < NOW() - INTERVAL '14 days'
        OR MAX(u.last_login) IS NULL
    ORDER BY days_inactive DESC NULLS LAST
    LIMIT 20
  `;
  return (rows as Row[]).map((row) => ({
    company_id: row.company_id as string,
    company_name: row.company_name as string,
    days_inactive: parseInt(row.days_inactive as string, 10) || 0,
    last_login: toISOString(row.last_login),
  }));
}

// Read-only: the platform has no persisted, enforced platform-wide toggles (maintenance mode,
// registration, max companies per user were removed - nothing ever read them). smtp_configured
// is derived from env.
export async function getPlatformSettings(): Promise<PlatformSettings> {
  return { smtp_configured: !!(process.env.SMTP_HOST ?? process.env.RESEND_API_KEY) };
}
