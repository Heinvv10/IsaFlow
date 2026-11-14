/**
 * Trial Management Service
 * Mutations for the trial company lifecycle on the IsaFlow Admin Platform:
 * extend a trial, convert it to a paid subscription. Reads (the list, the
 * counts) are in trialQueries.ts and re-exported here.
 */

import { sql, withTransaction } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { isConvertiblePlanCode } from '../types/trialPlans';

export { getAllTrials, getExpiringTrials, getTrialStats } from './trialQueries';
export type { TrialCompany, TrialState, TrialStats } from './trialQueries';

type Row = DbRow;

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return value as string;
}

/**
 * Extend a single company's trial by N days, counted from the later of its
 * current end and today (an expired trial restarts from today: adding 7 days to
 * a trial that ended 20 days ago used to leave it 13 days expired). The trial
 * subscription's period end moves with it. Null when no live company matched.
 */
export async function extendTrialIfExists(companyId: string, days: number): Promise<string | null> {
  const rows = await sql`
    WITH moved AS (
      UPDATE companies
      SET trial_ends_at = GREATEST(COALESCE(trial_ends_at, NOW()), NOW()) + (${days} || ' days')::interval,
          updated_at    = NOW()
      WHERE id = ${companyId}::uuid
        AND status IS DISTINCT FROM 'deleted'
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
  return rows.length === 0 ? null : toIso((rows[0] as Row).trial_ends_at);
}

/** Extend a single company's trial by N days. Returns updated trial_ends_at. */
export async function extendTrial(companyId: string, days: number): Promise<string> {
  const endsAt = await extendTrialIfExists(companyId, days);
  if (endsAt === null) throw new Error(`Company ${companyId} not found`);
  return endsAt;
}

/** Extend multiple companies' trials by N days (same rule as extendTrial). */
export async function bulkExtendTrials(companyIds: string[], days: number): Promise<number> {
  // RETURNING id, not .count: a tagged-template result has no .count, and the
  // 'deleted' predicate means the rows updated are not the ids that were asked for.
  const rows = (await sql`
    WITH moved AS (
      UPDATE companies
      SET trial_ends_at = GREATEST(COALESCE(trial_ends_at, NOW()), NOW()) + (${days} || ' days')::interval,
          updated_at    = NOW()
      WHERE id = ANY(${companyIds}::uuid[])
        AND status IS DISTINCT FROM 'deleted'
      RETURNING id, trial_ends_at
    ), subs AS (
      UPDATE subscriptions s
      SET current_period_end = m.trial_ends_at, updated_at = NOW()
      FROM moved m
      WHERE s.company_id = m.id AND s.status = 'trial'
      RETURNING s.id
    )
    SELECT id FROM moved
  `) as Record<string, unknown>[];

  log.info('Bulk trial extension applied', { requested: companyIds.length, extended: rows.length, days }, 'trialService');
  return rows.length;
}

export type TrialConvertErrorCode = 'company_not_found' | 'plan_not_found' | 'plan_not_convertible' | 'already_paid';

/** A convert the admin asked for that cannot happen. Thrown before anything is written. */
export class TrialConvertError extends Error {
  constructor(readonly code: TrialConvertErrorCode, message: string) {
    super(message);
    this.name = 'TrialConvertError';
  }
}

/**
 * Convert a trial company to a paying one, in ONE transaction (a savepoint of
 * the admin request's, so it commits or rolls back with the audit row):
 *  - the company row is locked, so two converts of the same company queue;
 *  - the plan must exist, be active and not be an internal plan (trial, payg);
 *  - a company that already pays (active/past_due on a real plan) is refused,
 *    never silently re-planned without proration;
 *  - the company's live trial subscription (status trial, or the free trial
 *    plan) is UPDATED to the new plan; with none, one is inserted. There is no
 *    unique index on subscriptions.company_id, so this is update-then-insert
 *    under the company lock, not ON CONFLICT;
 *  - the subscription gets a monthly period starting now, so the billing run
 *    (which skips a NULL current_period_end) bills it a month from now, as
 *    createSubscription does for an admin-made one.
 * The caller audits the action.
 */
export async function markAsConverted(companyId: string, planId: string): Promise<{ subscriptionId: string }> {
  const subscriptionId = await withTransaction(async (tx) => {
    const company = await tx`
      SELECT id FROM companies
      WHERE id = ${companyId}::uuid AND status IS DISTINCT FROM 'deleted'
      FOR UPDATE
    `;
    if (company.length === 0) throw new TrialConvertError('company_not_found', 'Company not found');

    const plan = (await tx`SELECT code, is_active FROM plans WHERE id = ${planId}::uuid`)[0] as Row | undefined;
    if (!plan) throw new TrialConvertError('plan_not_found', 'Plan not found');
    if (plan.is_active !== true || !isConvertiblePlanCode(plan.code as string)) {
      throw new TrialConvertError('plan_not_convertible', 'This plan cannot be used to convert a trial');
    }

    const current = (await tx`
      SELECT s.id, (s.status IN ('active', 'past_due') AND p.code <> 'trial') AS is_paid
      FROM subscriptions s
      JOIN plans p ON p.id = s.plan_id
      WHERE s.company_id = ${companyId}::uuid AND s.status IN ('trial', 'active', 'past_due', 'paused')
      ORDER BY (s.status IN ('active', 'past_due') AND p.code <> 'trial') DESC, s.created_at DESC
      LIMIT 1
    `)[0] as Row | undefined;
    if (current?.is_paid === true) {
      throw new TrialConvertError('already_paid', 'This company is already on a paid plan');
    }

    await tx`
      UPDATE companies
      SET status = 'active', plan_id = ${planId}::uuid, updated_at = NOW()
      WHERE id = ${companyId}::uuid
    `;

    const written = current
      ? await tx`
          UPDATE subscriptions
          SET plan_id = ${planId}::uuid, status = 'active', billing_cycle = 'monthly',
              current_period_start = NOW(), current_period_end = NOW() + INTERVAL '1 month',
              cancel_at_period_end = false, updated_at = NOW()
          WHERE id = ${current.id as string}::uuid
          RETURNING id
        `
      : await tx`
          INSERT INTO subscriptions (
            company_id, plan_id, status, billing_cycle,
            current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at
          ) VALUES (
            ${companyId}::uuid, ${planId}::uuid, 'active', 'monthly',
            NOW(), NOW() + INTERVAL '1 month', false, NOW(), NOW()
          )
          RETURNING id
        `;
    return (written[0] as Row).id as string;
  });

  log.info('markAsConverted', { companyId, planId, subscriptionId }, 'trialService');
  return { subscriptionId };
}
