/**
 * Admin Analytics Service
 * Platform health, usage analytics, and settings for ISAFlow Admin Platform.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { PlatformHealth, UsageAnalytics, PlatformSettings } from '../types/admin.types';
type Row = Record<string, unknown>;


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
    error_rate_percent: apiCalls.total > 0
      ? Math.round((apiCalls.errors / apiCalls.total) * 10000) / 100
      : 0,
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

  const stickiness = engagement.mau > 0
    ? Math.round((engagement.dau / engagement.mau) * 10000) / 100
    : 0;

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

async function getFeatureAdoption(): Promise<UsageAnalytics['feature_adoption']> {
  const totalRow = await sql`SELECT COUNT(*) AS total FROM companies WHERE status IS DISTINCT FROM 'deleted'`;
  const total = parseInt((totalRow[0] as Row).total as string, 10) || 1;

  const rows = await sql`
    SELECT
      ff.name AS feature,
      COUNT(DISTINCT cfo.company_id) AS user_count
    FROM feature_flags ff
    LEFT JOIN company_feature_overrides cfo ON cfo.feature_id = ff.id AND cfo.enabled = true
    GROUP BY ff.id, ff.name
    ORDER BY user_count DESC
  `;

  return (rows as Row[]).map((row) => ({
    feature: row.feature as string,
    user_count: parseInt(row.user_count as string, 10) || 0,
    adoption_percent: Math.round(((parseInt(row.user_count as string, 10) || 0) / total) * 10000) / 100,
  }));
}

async function getRevenueByPlan(): Promise<UsageAnalytics['revenue_by_plan']> {
  const rows = await sql`
    SELECT
      p.name AS plan_name,
      COUNT(s.id) AS company_count,
      COALESCE(SUM(
        CASE
          WHEN s.billing_cycle = 'monthly' THEN p.monthly_price_cents
          WHEN s.billing_cycle = 'annual'  THEN ROUND(p.annual_price_cents / 12.0)
          ELSE 0
        END
      ), 0) AS mrr_cents
    FROM plans p
    LEFT JOIN subscriptions s ON s.plan_id = p.id AND s.status IN ('active', 'trial')
    GROUP BY p.id, p.name
    ORDER BY mrr_cents DESC
  `;
  return (rows as Row[]).map((row) => ({
    plan_name: row.plan_name as string,
    mrr_cents: parseInt(row.mrr_cents as string, 10) || 0,
    company_count: parseInt(row.company_count as string, 10) || 0,
  }));
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

export async function getPlatformSettings(): Promise<PlatformSettings> {
  // MVP: sensible defaults — persistence table not yet implemented
  return {
    maintenance_mode: false,
    registration_enabled: true,
    default_trial_days: 14,
    max_companies_per_user: 5,
    smtp_configured: !!(process.env.SMTP_HOST ?? process.env.RESEND_API_KEY),
  };
}

export async function updatePlatformSettings(data: Partial<PlatformSettings>): Promise<void> {
  // MVP: no persistence table yet — log the intent only
  log.info('Platform settings update requested (no persistence yet)', {
    changes: data,
  }, 'analyticsService');
}
