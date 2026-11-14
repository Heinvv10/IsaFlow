/**
 * Admin Dashboard Service
 * Aggregates platform-wide KPIs for the IsaFlow Admin Platform.
 * Queries: company counts, user counts, MRR/ARR, recent activity.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getRevenueSummary } from './metrics/metricsSql';
import type { DashboardStats, ActivityEvent } from '../types/admin.types';
type Row = DbRow;


function toISOString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return value as string;
}

/**
 * Fetch platform-wide dashboard statistics.
 * Consolidates 4 scalar aggregates into a single round-trip to reduce
 * Neon connection pool pressure under concurrent load, then fetches
 * recent activity in a second query (UNION prevents combining cleanly).
 */
export async function getDashboardStats(): Promise<DashboardStats> {
  const [kpis, recentActivity] = await Promise.all([
    getKpis(),
    getRecentActivity(),
  ]);

  const stats: DashboardStats = {
    total_companies: kpis.total_companies,
    active_companies: kpis.active_companies,
    total_users: kpis.total_users,
    active_users_30d: kpis.active_users_30d,
    mrr_cents: kpis.mrr_cents,
    arr_cents: kpis.arr_cents,
    new_signups_30d: kpis.new_signups_30d,
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

/** The scalar KPIs in one query; MRR and ARR from the metrics module. */
async function getKpis(): Promise<{
  total_companies: number; active_companies: number;
  total_users: number; active_users_30d: number;
  mrr_cents: number; arr_cents: number;
  new_signups_30d: number;
}> {
  const [rows, revenue] = await Promise.all([sql`
    SELECT
      (SELECT COUNT(*)            FROM companies WHERE status IS DISTINCT FROM 'deleted')                AS total_companies,
      (SELECT COUNT(*)            FROM companies WHERE status = 'active')                               AS active_companies,
      (SELECT COUNT(*)            FROM companies WHERE created_at >= NOW() - INTERVAL '30 days'
                                                   AND status IS DISTINCT FROM 'deleted')              AS new_signups_30d,
      (SELECT COUNT(*)            FROM users     WHERE is_active = true)                               AS total_users,
      (SELECT COUNT(*)            FROM users     WHERE is_active = true
                                                   AND last_login >= NOW() - INTERVAL '30 days')       AS active_users_30d
  `, getRevenueSummary()]);
  const row = rows[0] as Row;
  return {
    total_companies:  parseInt(row.total_companies  as string, 10),
    active_companies: parseInt(row.active_companies as string, 10),
    new_signups_30d:  parseInt(row.new_signups_30d  as string, 10),
    total_users:      parseInt(row.total_users      as string, 10),
    active_users_30d: parseInt(row.active_users_30d as string, 10),
    mrr_cents: revenue.mrr_cents,
    arr_cents: revenue.arr_cents,
  };
}

/**
 * Most recent 50 events: admin_audit_log rows, plus each user's latest sign-in
 * of the last 7 days (`users.last_login`; `user_sessions` is no longer written).
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
    LEFT JOIN users u ON u.id = a.admin_user_id::text

    UNION ALL

    SELECT
      u.id::text                                                     AS id,
      'user_login'                                                   AS type,
      'User login'                                                   AS description,
      COALESCE(u.first_name || ' ' || u.last_name, u.email)          AS user_name,
      NULL::text                                                     AS company_name,
      u.last_login                                                   AS created_at
    FROM users u
    WHERE u.last_login >= NOW() - INTERVAL '7 days'

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
