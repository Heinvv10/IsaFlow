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
import { TrialConvertError, TrialExtendError } from './trialErrors';

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
export async function bulkExtendTrials(companyIds: string[], days: number): Promise<number> {
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
    SELECT id FROM moved
  `) as Record<string, unknown>[];

  log.info('Bulk trial extension applied', { requested: companyIds.length, extended: rows.length, days }, 'trialService');
  return rows.length;
}

export interface ConvertResult {
  subscriptionId: string;
  /** When billing first looks at the subscription: the end of its first period. */
  firstChargeAt: string;
  /** Charging needs an active Paystack mandate; without one the company is not billed. */
  hasActiveMandate: boolean;
}

/**
 * Convert a trial company to a paying one, in ONE transaction (a savepoint of
 * the admin request's, so it commits or rolls back with the audit row):
 *  - the company row is locked, so two converts of the same company queue;
 *  - the company must be on a trial or active: a suspended or cancelled one is
 *    refused (409), never silently reinstated, and no suspension column is touched;
 *  - the plan must exist, be active and not be an internal plan (trial, payg);
 *  - a company that already pays (active/past_due on a real plan) is refused,
 *    never silently re-planned without proration; a company with any paused
 *    subscription is refused too (resume or cancel it first);
 *  - the newest live trial/free-plan subscription is UPDATED to the new plan and
 *    every other live trial row of the company is cancelled, so one live
 *    subscription remains; with none, one is inserted. There is no unique index
 *    on subscriptions.company_id, so this is update-then-insert under the
 *    company lock, not ON CONFLICT;
 *  - the subscription gets a monthly period starting now, so the billing run
 *    (which skips a NULL current_period_end) bills it a month from now, as
 *    createSubscription does for an admin-made one, and only if the company has
 *    an active Paystack mandate (reported back).
 * The caller audits the action.
 */
export async function markAsConverted(companyId: string, planId: string): Promise<ConvertResult> {
  const result = await withTransaction(async (tx): Promise<ConvertResult> => {
    const company = (await tx`
      SELECT COALESCE(status, 'active') AS status FROM companies
      WHERE id = ${companyId}::uuid AND status IS DISTINCT FROM 'deleted'
      FOR UPDATE
    `)[0] as Row | undefined;
    if (!company) throw new TrialConvertError('company_not_found', 'Company not found');
    if (company.status !== 'trial' && company.status !== 'active') {
      throw new TrialConvertError('company_not_convertible', `Company status "${String(company.status)}" cannot be converted`);
    }

    const plan = (await tx`SELECT code, is_active FROM plans WHERE id = ${planId}::uuid`)[0] as Row | undefined;
    if (!plan) throw new TrialConvertError('plan_not_found', 'Plan not found');
    if (plan.is_active !== true || !isConvertiblePlanCode(plan.code as string)) {
      throw new TrialConvertError('plan_not_convertible', 'This plan cannot be used to convert a trial');
    }

    const current = (await tx`
      SELECT s.id, s.status, (s.status IN ('active', 'past_due') AND p.code <> 'trial') AS is_paid
      FROM subscriptions s
      JOIN plans p ON p.id = s.plan_id
      WHERE s.company_id = ${companyId}::uuid AND s.status IN ('trial', 'active', 'past_due', 'paused')
      ORDER BY (s.status IN ('active', 'past_due') AND p.code <> 'trial') DESC, s.created_at DESC
      LIMIT 1
    `)[0] as Row | undefined;
    if (current?.is_paid === true) {
      throw new TrialConvertError('already_paid', 'This company is already on a paid plan');
    }
    // ANY paused subscription, not only the newest row: converting beside one would leave it behind.
    const paused = await tx`
      SELECT 1 FROM subscriptions WHERE company_id = ${companyId}::uuid AND status = 'paused' LIMIT 1
    `;
    if (paused.length > 0) {
      throw new TrialConvertError('subscription_paused', 'Resume or cancel the paused subscription first');
    }

    await tx`
      UPDATE companies
      SET status = 'active', plan_id = ${planId}::uuid, updated_at = NOW()
      WHERE id = ${companyId}::uuid
    `;

    let written: unknown[];
    if (current) {
      written = await tx`
        UPDATE subscriptions
        SET plan_id = ${planId}::uuid, status = 'active', billing_cycle = 'monthly',
            current_period_start = NOW(), current_period_end = NOW() + INTERVAL '1 month',
            cancel_at_period_end = false, updated_at = NOW()
        WHERE id = ${current.id as string}::uuid
        RETURNING id, current_period_end
      `;
      // Any other live trial row (a stray second trial, or "active" on the free plan) would
      // double-count and could be billed: end it.
      await tx`
        UPDATE subscriptions
        SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
        WHERE company_id = ${companyId}::uuid
          AND id <> ${current.id as string}::uuid
          AND status IN ('trial', 'active', 'past_due', 'paused')
          AND (status = 'trial' OR plan_id IN (SELECT id FROM plans WHERE code = 'trial'))
      `;
    } else {
      written = await tx`
        INSERT INTO subscriptions (
          company_id, plan_id, status, billing_cycle,
          current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at
        ) VALUES (
          ${companyId}::uuid, ${planId}::uuid, 'active', 'monthly',
          NOW(), NOW() + INTERVAL '1 month', false, NOW(), NOW()
        )
        RETURNING id, current_period_end
      `;
    }

    const mandate = await tx`
      SELECT 1 FROM subscription_mandates
      WHERE company_id = ${companyId}::uuid AND gateway = 'paystack' AND status = 'active'
      LIMIT 1
    `;
    const row = written[0] as Row;
    return { subscriptionId: row.id as string, firstChargeAt: toIso(row.current_period_end), hasActiveMandate: mandate.length > 0 };
  });

  log.info('markAsConverted', { companyId, planId, ...result }, 'trialService');
  return result;
}
