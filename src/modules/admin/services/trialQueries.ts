/**
 * Trial queries for the admin Trials page, the dashboard, the billing overview
 * and the health widget.
 *
 * ONE query (`loadTrials`) reads every trial company; the list, the "expiring"
 * list and every count are then derived from those rows in JS, so a card can
 * never disagree with the table beneath it (admin audit 2.2). A company is
 *   - converted: it has a paying subscription (active or past_due, on a plan
 *     other than the free `trial` plan);
 *   - expired:   not converted and trial_ends_at is in the past;
 *   - active:    not converted and trial_ends_at is still ahead.
 * `companies.status` plays no part: provisioning never sets a trial status, and
 * a subscription that is "active" on the free trial plan is not a customer.
 * Nothing here changes a tenant's access.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export type TrialState = 'active' | 'expired' | 'converted';

export interface TrialCompany {
  id: string;
  name: string;
  plan_name: string | null;
  trial_ends_at: string;
  trial_started_at: string | null;
  user_count: number;
  /** companies.status, as stored (suspended, active...). */
  status: string;
  trial_state: TrialState;
  /** Whole days, rounded up: 12 hours left is 1; an expired trial is 0 or negative. */
  days_left: number;
  converted_at: string | null;
}

export interface TrialStats {
  /** Every trial company: the rows of the All Trials tab. */
  total_trials: number;
  active_trials: number;
  expiring_this_week: number;
  expired_unpaid: number;
  converted_this_month: number;
  conversion_rate_percent: number;
}

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function isoOrNull(value: unknown): string | null {
  return value == null ? null : iso(value);
}

/** One row of the single trials query, as the database returns it. */
export function classifyTrial(r: DbRow, now: Date): TrialCompany {
  const endsAt = iso(r.trial_ends_at);
  const msLeft = new Date(endsAt).getTime() - now.getTime();
  const isPaid = r.is_paid === true;
  return {
    id: r.id as string,
    name: r.name as string,
    plan_name: (r.plan_name as string | null) ?? null,
    trial_ends_at: endsAt,
    trial_started_at: isoOrNull(r.trial_started_at),
    user_count: parseInt(String(r.user_count), 10) || 0,
    status: r.status as string,
    trial_state: isPaid ? 'converted' : msLeft < 0 ? 'expired' : 'active',
    days_left: Math.ceil(msLeft / DAY_MS) || 0,
    converted_at: isPaid ? isoOrNull(r.converted_at) : null,
  };
}

export function summariseTrials(trials: TrialCompany[], now: Date): TrialStats {
  const count = (keep: (t: TrialCompany) => boolean) => trials.filter(keep).length;
  const active = (t: TrialCompany) => t.trial_state === 'active';
  const convertedRecently = count((t) => t.trial_state === 'converted' && t.converted_at !== null
    && new Date(t.converted_at).getTime() >= now.getTime() - 30 * DAY_MS);
  return {
    total_trials: trials.length,
    active_trials: count(active),
    expiring_this_week: count((t) => active(t) && new Date(t.trial_ends_at).getTime() - now.getTime() <= WEEK_MS),
    expired_unpaid: count((t) => t.trial_state === 'expired'),
    converted_this_month: convertedRecently,
    conversion_rate_percent: trials.length > 0 ? Math.round((convertedRecently / trials.length) * 10000) / 100 : 0,
  };
}

/** The single trials query: every non-deleted company with a trial_ends_at, soonest end first. */
async function loadTrials(now: Date): Promise<TrialCompany[]> {
  const rows = await sql`
    SELECT
      c.id::text                    AS id,
      c.name,
      c.trial_ends_at,
      c.created_at                  AS trial_started_at,
      COALESCE(c.status, 'active')  AS status,
      COALESCE(uc.user_count, 0)    AS user_count,
      cs.plan_name,
      COALESCE(cs.is_paid, false)   AS is_paid,
      CASE WHEN cs.is_paid THEN COALESCE(
        (SELECT MAX(a.created_at) FROM admin_audit_log a
          WHERE a.action = 'trial.convert_to_paid' AND a.target_id = c.id::text),
        cs.sub_created_at) END      AS converted_at
    FROM companies c
    LEFT JOIN LATERAL (
      -- The company's current subscription: a paying one first, else the newest live one.
      SELECT p.name AS plan_name, s.created_at AS sub_created_at,
             (s.status IN ('active', 'past_due') AND p.code <> 'trial') AS is_paid
      FROM subscriptions s
      JOIN plans p ON p.id = s.plan_id
      WHERE s.company_id = c.id AND s.status IN ('trial', 'active', 'past_due', 'paused')
      ORDER BY (s.status IN ('active', 'past_due') AND p.code <> 'trial') DESC, s.created_at DESC
      LIMIT 1
    ) cs ON true
    LEFT JOIN (
      SELECT company_id, COUNT(*) AS user_count FROM company_users GROUP BY company_id
    ) uc ON uc.company_id = c.id
    WHERE c.trial_ends_at IS NOT NULL
      AND c.status IS DISTINCT FROM 'deleted'
    ORDER BY c.trial_ends_at ASC
  `;
  return (rows as DbRow[]).map((r) => classifyTrial(r, now));
}

/** Every trial company, expired and converted included, for the management table. */
export async function getAllTrials(now = new Date()): Promise<TrialCompany[]> {
  return loadTrials(now);
}

/** Trials still running that end within the next N days, soonest first. */
export async function getExpiringTrials(withinDays = 30, now = new Date()): Promise<TrialCompany[]> {
  const horizon = now.getTime() + withinDays * DAY_MS;
  return (await loadTrials(now)).filter((t) => t.trial_state === 'active' && new Date(t.trial_ends_at).getTime() <= horizon);
}

/** The counts for the Trials cards, the billing overview and the health widget. */
export async function getTrialStats(now = new Date()): Promise<TrialStats> {
  return summariseTrials(await loadTrials(now), now);
}
