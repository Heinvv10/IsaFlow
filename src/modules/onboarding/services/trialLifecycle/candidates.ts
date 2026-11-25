/**
 * The trial companies the daily run considers, and their owners. Runs on the service pool
 * (isaflow_service → app_service, the 915 mirrors), so every statement names its company itself.
 *
 * A candidate is a company with a trial end date no older than ENDED_WINDOW_DAYS that is NOT:
 * deleted, a demo/internal company (companyOutOfMetrics: is_demo, the Demo tenant; the golden-gate
 * "Deploy Verification" company is is_demo and has no trial end), suspended, converted (a paying
 * subscription: active or past_due on a plan other than `trial`, as trialQueries.ts), or listed in env
 * TRIAL_EMAIL_EXCLUDE_COMPANY_IDS. Stage selection happens in code (stages.ts) so the batch limit
 * counts only companies that have something due.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { companyOutOfMetrics } from '@/modules/admin/services/metrics/metricsSql';
import { ENDED_WINDOW_DAYS, SETUP_NUDGE_DAY, TRIAL_STAGES, type TrialStage } from './stages';

export interface TrialCandidate {
  companyId: string;
  companyName: string;
  createdAt: Date;
  trialEndsAt: Date;
  /** Stages already done (every marker outcome except 'released'). */
  doneStages: TrialStage[];
}

export interface TrialRecipient {
  email: string;
  name: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** env TRIAL_EMAIL_EXCLUDE_COMPANY_IDS: comma-separated company UUIDs; anything else is ignored. */
export function excludedCompanyIds(raw = process.env.TRIAL_EMAIL_EXCLUDE_COMPANY_IDS): string[] {
  return (raw ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => UUID_RE.test(s));
}

function asDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}

export async function loadTrialCandidates(now: Date): Promise<TrialCandidate[]> {
  const exclude = excludedCompanyIds();
  const rows = (await sql`
    SELECT c.id::TEXT AS id, c.name, c.created_at, c.trial_ends_at,
           COALESCE((SELECT array_agg(t.stage::TEXT) FROM trial_lifecycle_emails t
                      WHERE t.company_id = c.id AND t.outcome <> 'released'), ARRAY[]::TEXT[]) AS done_stages
      FROM companies c
     WHERE c.trial_ends_at IS NOT NULL
       AND c.trial_ends_at >= ${now.toISOString()}::TIMESTAMPTZ - make_interval(days => ${ENDED_WINDOW_DAYS})
       AND c.created_at <= ${now.toISOString()}::TIMESTAMPTZ - make_interval(days => ${SETUP_NUDGE_DAY})
       AND NOT ${companyOutOfMetrics()}
       AND c.status IS DISTINCT FROM 'suspended' AND c.suspended_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM subscriptions s JOIN plans p ON p.id = s.plan_id
                        WHERE s.company_id = c.id AND s.status IN ('active', 'past_due') AND p.code <> 'trial')
       AND NOT (c.id = ANY (${exclude}::UUID[]))
     ORDER BY c.trial_ends_at ASC, c.id
  `) as DbRow[];
  return rows.map((r) => ({
    companyId: String(r.id),
    companyName: String(r.name ?? ''),
    createdAt: asDate(r.created_at),
    trialEndsAt: asDate(r.trial_ends_at),
    doneStages: ((r.done_stages as string[] | null) ?? []).filter((s): s is TrialStage => (TRIAL_STAGES as readonly string[]).includes(s)),
  }));
}

/** Active owners of the company with an email address (overspendDigest.ts's shape, owners only). */
export async function loadOwners(companyId: string): Promise<TrialRecipient[]> {
  const rows = (await sql`
    SELECT DISTINCT u.email, COALESCE(NULLIF(btrim(u.first_name), ''), 'there') AS name
      FROM company_users cu JOIN users u ON u.id = cu.user_id
     WHERE cu.company_id = ${companyId}::UUID AND cu.role = 'owner'
       AND u.is_active IS TRUE AND u.status IS DISTINCT FROM 'suspended' AND u.suspended_at IS NULL
       AND btrim(COALESCE(u.email, '')) <> ''
     ORDER BY u.email
  `) as DbRow[];
  return rows.map((r) => ({ email: String(r.email), name: String(r.name) }));
}
