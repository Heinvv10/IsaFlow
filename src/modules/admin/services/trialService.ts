/**
 * Trial Management Service
 * Mutations for the trial company lifecycle on the IsaFlow Admin Platform:
 * extend a trial, convert it to a paid subscription. Reads (the list, the
 * counts) are in trialQueries.ts and re-exported here.
 */

import { sql, withTransaction } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { TrialExtendError } from './trialErrors';
import { convertTrialInTx, type ConvertResult } from './trialConvertCore';

export { getAllTrials, getExpiringTrials, getTrialStats } from './trialQueries';
export type { TrialCompany, TrialState, TrialStats } from './trialQueries';
export { TrialConvertError, TrialExtendError } from './trialErrors';

type Row = DbRow;

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return value as string;
}

// A company paying for a real plan is no longer on a trial (its trial_ends_at is
// history), so the three extend statements below skip it. The predicate is
// repeated in each because a tagged template cannot compose fragments.

export type ExtendResult =
  | { kind: 'extended'; trialEndsAt: string }
  | { kind: 'not_found' }
  | { kind: 'already_paid' };

/**
 * Extend a single company's trial by N days, counted from the later of its
 * current end and today (an expired trial restarts from today: adding 7 days to
 * a trial that ended 20 days ago used to leave it 13 days expired). The trial
 * subscription's period end moves with it. A deleted or missing company is
 * `not_found`; one that already pays is `already_paid` and is left alone.
 */
export async function extendTrialIfExists(companyId: string, days: number): Promise<ExtendResult> {
  const rows = await sql`
    WITH moved AS (
      UPDATE companies
      SET trial_ends_at = GREATEST(COALESCE(trial_ends_at, NOW()), NOW()) + (${days} || ' days')::interval,
          updated_at    = NOW()
      WHERE id = ${companyId}::uuid
        AND status IS DISTINCT FROM 'deleted'
        AND NOT EXISTS (
          SELECT 1 FROM subscriptions ps JOIN plans pp ON pp.id = ps.plan_id
          WHERE ps.company_id = companies.id AND ps.status IN ('active', 'past_due') AND pp.code <> 'trial')
      RETURNING id, trial_ends_at
    ), subs AS (
      UPDATE subscriptions s
      SET current_period_end = m.trial_ends_at, updated_at = NOW()
      FROM moved m
      WHERE s.company_id = m.id AND s.status = 'trial'
      RETURNING s.id
    )
    SELECT trial_ends_at FROM moved
  `;
  if (rows.length > 0) return { kind: 'extended', trialEndsAt: toIso((rows[0] as Row).trial_ends_at) };
  const exists = await sql`SELECT 1 FROM companies WHERE id = ${companyId}::uuid AND status IS DISTINCT FROM 'deleted'`;
  return exists.length > 0 ? { kind: 'already_paid' } : { kind: 'not_found' };
}

/** Extend a single company's trial by N days. Returns updated trial_ends_at. */
export async function extendTrial(companyId: string, days: number): Promise<string> {
  const result = await extendTrialIfExists(companyId, days);
  if (result.kind === 'not_found') throw new TrialExtendError('company_not_found', 'Company not found');
  if (result.kind === 'already_paid') throw new TrialExtendError('already_paid', 'This company is already on a paid plan');
  return result.trialEndsAt;
}

/** Extend multiple companies' trials by N days (same rule as extendTrial); deleted and paying ones are skipped. */
/** How many companies bulkExtendTrialsDetailed moved. */
export async function bulkExtendTrials(companyIds: string[], days: number): Promise<number> {
  return (await bulkExtendTrialsDetailed(companyIds, days)).length;
}

/** The companies a bulk extension moved (each with its new trial end): one audit row each (review #1405 round 7). */
export async function bulkExtendTrialsDetailed(
  companyIds: string[], days: number,
): Promise<Array<{ id: string; trialEndsAt: string }>> {
  // RETURNING id, not .count: a tagged-template result has no .count, and the
  // predicates mean the rows updated are not the ids that were asked for.
  const rows = (await sql`
    WITH moved AS (
      UPDATE companies
      SET trial_ends_at = GREATEST(COALESCE(trial_ends_at, NOW()), NOW()) + (${days} || ' days')::interval,
          updated_at    = NOW()
      WHERE id = ANY(${companyIds}::uuid[])
        AND status IS DISTINCT FROM 'deleted'
        AND NOT EXISTS (
          SELECT 1 FROM subscriptions ps JOIN plans pp ON pp.id = ps.plan_id
          WHERE ps.company_id = companies.id AND ps.status IN ('active', 'past_due') AND pp.code <> 'trial')
      RETURNING id, trial_ends_at
    ), subs AS (
      UPDATE subscriptions s
      SET current_period_end = m.trial_ends_at, updated_at = NOW()
      FROM moved m
      WHERE s.company_id = m.id AND s.status = 'trial'
      RETURNING s.id
    )
    SELECT id, trial_ends_at FROM moved
  `) as Record<string, unknown>[];

  log.info('Bulk trial extension applied', { requested: companyIds.length, extended: rows.length, days }, 'trialService');
  return rows.map((r) => ({
    id: String(r.id),
    trialEndsAt: r.trial_ends_at instanceof Date ? r.trial_ends_at.toISOString() : String(r.trial_ends_at),
  }));
}

export type { ConvertResult } from './trialConvertCore';

/**
 * Convert a trial company to a paying one, in ONE transaction (a savepoint of
 * the admin request's, so it commits or rolls back with the audit row). The
 * rules are convertTrialInTx's (trialConvertCore.ts), shared with the tenant's
 * self-serve upgrade; the admin path uses none of its options, so a mandate is
 * not required here and the result reports whether one is on file.
 * The caller audits the action.
 */
export async function markAsConverted(companyId: string, planId: string): Promise<ConvertResult> {
  const result = await withTransaction((tx) => convertTrialInTx(tx, companyId, planId));
  log.info('markAsConverted', { companyId, planId, ...result }, 'trialService');
  return result;
}
