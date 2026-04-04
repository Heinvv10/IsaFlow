/**
 * Admin Dashboard Service
 * Aggregates platform-wide KPIs for the ISAFlow Admin Platform.
 * Queries: company counts, user counts, MRR/ARR, recent activity.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DashboardStats, ActivityEvent } from '../types/admin.types';
type Row = Record<string, unknown>;


function toISOString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return value as string;
}

/**
 * Fetch platform-wide dashboard statistics.
 * Runs aggregate queries in parallel for performance.
 */
export async function getDashboardStats(): Promise<DashboardStats> {
  const [companyStats, userStats, mrrStats, signupCount, recentActivity] =
    await Promise.all([
      getCompanyStats(),
      getUserStats(),
      getMrrStats(),
      getNewSignupCount(),
      getRecentActivity(),
    ]);

  const stats: DashboardStats = {
    total_companies: companyStats.total,
    active_companies: companyStats.active,
    total_users: userStats.total,
    active_users_30d: userStats.active_30d,
    mrr_cents: mrrStats.mrr_cents,
    arr_cents: mrrStats.arr_cents,
    new_signups_30d: signupCount,
    recent_activity: recentActivity,
  };

  log.info('Admin dashboard stats fetched', {
    total_companies: stats.total_companies,
    active_companies: stats.active_companies,
    total_users: stats.total_users,
    mrr_cents: stats.mrr_cents,
  }, 'AdminDashboardService');

  return stats;
}

async function getCompanyStats(): Promise<{ total: number; active: number }> {
  const rows = await sql`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'active') AS active
    FROM companies
    WHERE status IS DISTINCT FROM 'deleted'
  `;
  const row = rows[0] as Row;
  return {
    total: parseInt(row.total as string, 10),
    active: parseInt(row.active as string, 10),
  };
}

async function getUserStats(): Promise<{ total: number; active_30d: number }> {
  const rows = await sql`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE last_login >= NOW() - INTERVAL '30 days') AS active_30d
    FROM users
    WHERE is_active = true
  `;
  const row = rows[0] as Row;
  return {
    total: parseInt(row.total as string, 10),
    active_30d: parseInt(row.active_30d as string, 10),
  };
}

async function getMrrStats(): Promise<{ mrr_cents: number; arr_cents: number }> {
  // Monthly: sum monthly_price_cents
  // Annual: normalise to monthly (divide by 12)
  const rows = await sql`
    SELECT
      COALESCE(SUM(
        CASE
          WHEN s.billing_cycle = 'monthly' THEN p.monthly_price_cents
          WHEN s.billing_cycle = 'annual'  THEN ROUND(p.annual_price_cents / 12.0)
          ELSE 0
        END
      ), 0) AS mrr_cents
    FROM subscriptions s
    INNER JOIN plans p ON p.id = s.plan_id
    WHERE s.status IN ('active', 'trial')
  `;
  const mrr = parseInt((rows[0] as Row).mrr_cents as string, 10);
  return { mrr_cents: mrr, arr_cents: mrr * 12 };
}

async function getNewSignupCount(): Promise<number> {
  const rows = await sql`
    SELECT COUNT(*) AS count
    FROM companies
    WHERE created_at >= NOW() - INTERVAL '30 days'
      AND status IS DISTINCT FROM 'deleted'
  `;
  return parseInt((rows[0] as Row).count as string, 10);
}

/**
 * Most recent 50 events from admin_audit_log + recent user_sessions.
 */
async function getRecentActivity(): Promise<ActivityEvent[]> {
  const rows = await sql`
    SELECT
      a.id::text                                                     AS id,
      'admin_action'                                                 AS type,
      a.action || ' ' || a.target_type                              AS description,
      COALESCE(u.first_name || ' ' || u.last_name, u.email)          AS user_name,
      NULL::text                                                     AS company_name,
      a.created_at
    FROM admin_audit_log a
    LEFT JOIN users u ON u.id = a.admin_user_id

    UNION ALL

    SELECT
      s.id::text                                                     AS id,
      'user_login'                                                   AS type,
      'User login'                                                   AS description,
      COALESCE(u.first_name || ' ' || u.last_name, u.email)          AS user_name,
      NULL::text                                                     AS company_name,
      s.created_at
    FROM user_sessions s
    INNER JOIN users u ON u.id = s.user_id
    WHERE s.created_at >= NOW() - INTERVAL '7 days'

    ORDER BY created_at DESC
    LIMIT 50
  `;

  return (rows as Row[]).map((row) => ({
    id: row.id as string,
    type: row.type as string,
    description: row.description as string,
    user_name: row.user_name as string | null,
    company_name: row.company_name as string | null,
    created_at: toISOString(row.created_at),
  }));
}
