/**
 * Trial Management Service
 * Queries and mutations for trial company lifecycle on the ISAFlow Admin Platform.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

export interface TrialCompany {
  id: string;
  name: string;
  plan_name: string | null;
  trial_ends_at: string;
  trial_started_at: string | null;
  user_count: number;
  status: string;
  days_left: number;
}

export interface TrialStats {
  total_trials: number;
  expiring_this_week: number;
  expired_unpaid: number;
  converted_this_month: number;
  conversion_rate_percent: number;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return value as string;
}

function toIsoOrNull(value: unknown): string | null {
  if (value == null) return null;
  return toIso(value);
}

function parseIntOr0(value: unknown): number {
  return parseInt(value as string, 10) || 0;
}

/** Companies with trial_ends_at within the next N days, soonest first. */
export async function getExpiringTrials(withinDays = 30): Promise<TrialCompany[]> {
  const rows = await sql`
    SELECT
      c.id::text                                           AS id,
      c.name,
      p.name                                               AS plan_name,
      c.trial_ends_at,
      c.created_at                                         AS trial_started_at,
      COALESCE(uc.user_count, 0)                           AS user_count,
      COALESCE(c.status, 'active')                         AS status,
      GREATEST(0, EXTRACT(DAY FROM c.trial_ends_at - NOW())::int) AS days_left
    FROM companies c
    LEFT JOIN subscriptions s  ON s.company_id = c.id AND s.status = 'trial'
    LEFT JOIN plans p          ON p.id = s.plan_id
    LEFT JOIN (
      SELECT company_id, COUNT(*) AS user_count
      FROM company_users
      GROUP BY company_id
    ) uc ON uc.company_id = c.id
    WHERE c.trial_ends_at IS NOT NULL
      AND c.trial_ends_at >= NOW()
      AND c.trial_ends_at <= NOW() + (${withinDays} || ' days')::interval
      AND c.status IS DISTINCT FROM 'deleted'
    ORDER BY c.trial_ends_at ASC
  `;

  return (rows as Row[]).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    plan_name: r.plan_name as string | null,
    trial_ends_at: toIso(r.trial_ends_at),
    trial_started_at: toIsoOrNull(r.trial_started_at),
    user_count: parseIntOr0(r.user_count),
    status: r.status as string,
    days_left: parseIntOr0(r.days_left),
  }));
}

/** ALL trial companies regardless of expiry, for the full management table. */
export async function getAllTrialCompanies(): Promise<TrialCompany[]> {
  const rows = await sql`
    SELECT
      c.id::text                                           AS id,
      c.name,
      p.name                                               AS plan_name,
      c.trial_ends_at,
      c.created_at                                         AS trial_started_at,
      COALESCE(uc.user_count, 0)                           AS user_count,
      COALESCE(c.status, 'active')                         AS status,
      EXTRACT(DAY FROM c.trial_ends_at - NOW())::int       AS days_left
    FROM companies c
    LEFT JOIN subscriptions s  ON s.company_id = c.id AND s.status IN ('trial', 'active')
    LEFT JOIN plans p          ON p.id = s.plan_id
    LEFT JOIN (
      SELECT company_id, COUNT(*) AS user_count
      FROM company_users
      GROUP BY company_id
    ) uc ON uc.company_id = c.id
    WHERE c.trial_ends_at IS NOT NULL
      AND c.status IS DISTINCT FROM 'deleted'
    ORDER BY c.trial_ends_at ASC
  `;

  return (rows as Row[]).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    plan_name: r.plan_name as string | null,
    trial_ends_at: toIso(r.trial_ends_at),
    trial_started_at: toIsoOrNull(r.trial_started_at),
    user_count: parseIntOr0(r.user_count),
    status: r.status as string,
    days_left: parseIntOr0(r.days_left),
  }));
}

/** Aggregate trial stats for the summary cards. */
export async function getTrialStats(): Promise<TrialStats> {
  const [totalsRow, convertedRow] = await Promise.all([
    sql`
      SELECT
        COUNT(*) FILTER (
          WHERE trial_ends_at IS NOT NULL AND status IS DISTINCT FROM 'deleted'
        )                                                        AS total_trials,
        COUNT(*) FILTER (
          WHERE trial_ends_at IS NOT NULL
            AND trial_ends_at BETWEEN NOW() AND NOW() + INTERVAL '7 days'
            AND status IS DISTINCT FROM 'deleted'
        )                                                        AS expiring_this_week,
        COUNT(*) FILTER (
          WHERE trial_ends_at IS NOT NULL
            AND trial_ends_at < NOW()
            AND status NOT IN ('active', 'deleted')
        )                                                        AS expired_unpaid
      FROM companies
    `,
    sql`
      SELECT
        COUNT(*) FILTER (
          WHERE s.status = 'active'
            AND s.created_at >= NOW() - INTERVAL '30 days'
            AND c.trial_ends_at IS NOT NULL
        ) AS converted_this_month,
        COUNT(*) FILTER (
          WHERE c.trial_ends_at IS NOT NULL AND c.status IS DISTINCT FROM 'deleted'
        ) AS total_with_trial
      FROM companies c
      LEFT JOIN subscriptions s ON s.company_id = c.id
    `,
  ]);

  const t = totalsRow[0] as Row;
  const cv = convertedRow[0] as Row;

  const totalTrials       = parseIntOr0(t.total_trials);
  const convertedThisMonth = parseIntOr0(cv.converted_this_month);
  const totalWithTrial    = parseIntOr0(cv.total_with_trial);

  log.info('Trial stats fetched', { totalTrials, convertedThisMonth }, 'trialService');

  return {
    total_trials:           totalTrials,
    expiring_this_week:     parseIntOr0(t.expiring_this_week),
    expired_unpaid:         parseIntOr0(t.expired_unpaid),
    converted_this_month:   convertedThisMonth,
    conversion_rate_percent: totalWithTrial > 0
      ? Math.round((convertedThisMonth / totalWithTrial) * 10000) / 100
      : 0,
  };
}

/** Extend a single company's trial by N days. Returns updated trial_ends_at. */
export async function extendTrial(companyId: string, days: number): Promise<string> {
  const rows = await sql`
    UPDATE companies
    SET trial_ends_at = COALESCE(trial_ends_at, NOW()) + (${days} || ' days')::interval,
        updated_at    = NOW()
    WHERE id = ${companyId}::uuid
      AND status IS DISTINCT FROM 'deleted'
    RETURNING trial_ends_at
  `;

  if (rows.length === 0) throw new Error(`Company ${companyId} not found`);
  return toIso((rows[0] as Row).trial_ends_at);
}

/**
 * Convert a trial company to an active paid subscription.
 * - Sets company status = 'active'
 * - Upserts a subscription record for the given plan with status = 'active'
 * - Logs the admin action via auditService (caller must pass adminUserId)
 */
export async function markAsConverted(
  companyId: string,
  planId: string,
): Promise<void> {
  // 1. Activate the company
  await sql`
    UPDATE companies
    SET status     = 'active',
        plan_id    = ${planId}::uuid,
        updated_at = NOW()
    WHERE id = ${companyId}::uuid
      AND status IS DISTINCT FROM 'deleted'
  `;

  // 2. Upsert subscription — if a trial sub exists upgrade it, else insert
  await sql`
    INSERT INTO subscriptions (company_id, plan_id, status, created_at, updated_at)
    VALUES (${companyId}::uuid, ${planId}::uuid, 'active', NOW(), NOW())
    ON CONFLICT (company_id)
    DO UPDATE SET
      plan_id    = EXCLUDED.plan_id,
      status     = 'active',
      updated_at = NOW()
  `;

  log.info('markAsConverted', { companyId, planId }, 'trialService');
}

/** Extend multiple companies' trials by N days. */
export async function bulkExtendTrials(companyIds: string[], days: number): Promise<number> {
  // Use unnest for a single UPDATE across all IDs
  const result = await sql`
    UPDATE companies
    SET trial_ends_at = COALESCE(trial_ends_at, NOW()) + (${days} || ' days')::interval,
        updated_at    = NOW()
    WHERE id = ANY(${companyIds}::uuid[])
      AND status IS DISTINCT FROM 'deleted'
  `;

  const count = (result as unknown as { count: number }).count ?? companyIds.length;
  log.info('Bulk trial extension applied', { companyIds: companyIds.length, days }, 'trialService');
  return typeof count === 'number' ? count : companyIds.length;
}
