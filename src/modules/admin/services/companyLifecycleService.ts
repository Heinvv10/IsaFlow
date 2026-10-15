/**
 * Company delete and restore (admin platform).
 *
 * Delete is a soft delete: companies.status = 'deleted'. Members lose access
 * (companyMembership excludes deleted companies), the subscription cron skips
 * the company, and every row is kept so restoreCompany can bring it back.
 *
 * Billing across a delete/restore ("fresh start", Hein 2026-10-15):
 * - delete voids the company's unsent charges for periods not yet granted
 *   (period_start at or after the subscription's current_period_end) — the
 *   same rule voidChargesForCancellingSubscriptions uses. A charge for a
 *   period already granted is a debt for time used; it is kept, and
 *   runQueuedCharges leaves it alone while the company is deleted.
 * - restore applies the same void again first (a charge in flight at Paystack
 *   during the delete, `submitted`, may have become `failed` since), then
 *   starts a new period from the restore date: a subscription whose period
 *   ended while the company was deleted gets current_period_end = now, so the
 *   next cron raises one charge from today instead of one per missed cycle.
 *   A company restored as suspended is billed like any suspended company.
 *   Not restarted: a subscription with a charge still in flight (`submitted`)
 *   — it resumes as if never deleted. A restarted subscription flagged
 *   cancel_at_period_end is closed out by the next cron (its period has ended).
 *
 * Accepted limits (same as the cancel-at-period-end void):
 * - money that later arrives against a voided charge is refused by
 *   settleSubscriptionCharge, which logs "no longer settleable" — a refund case.
 * - a charge the cron has already claimed when the delete runs is still
 *   debited; the cron's own status write then records what really happened
 *   (submitted / settled) over the 'cancelled'.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

/** Returns false when the company does not exist or is already deleted. */
export async function deleteCompany(companyId: string): Promise<boolean> {
  const rows = await sql<{ id: string; voided: string[] }>`
    WITH co AS (
      UPDATE companies
      SET status     = 'deleted',
          updated_at = NOW()
      WHERE id = ${companyId}
        AND status IS DISTINCT FROM 'deleted'
      RETURNING id
    ), voided AS (
      UPDATE subscription_charges c
      SET status = 'cancelled',
          failure_reason = COALESCE(c.failure_reason, 'company_deleted'),
          updated_at = now()
      FROM subscriptions s, co
      WHERE c.company_id = co.id
        AND s.id = c.subscription_id
        AND s.company_id = c.company_id
        AND c.status IN ('queued','failed')
        AND (s.current_period_end IS NULL
             OR c.period_start >= (s.current_period_end AT TIME ZONE 'UTC')::date)
      RETURNING c.id
    )
    SELECT co.id, ARRAY(SELECT id::text FROM voided) AS voided FROM co
  `;
  const row = rows[0];
  if (!row) return false;
  // The voided ids are logged so a late Paystack settlement on one (refused,
  // a refund case) can be traced back to this delete.
  log.info('deleteCompany (soft)', { companyId, voidedChargeIds: row.voided }, 'CompanyLifecycle');
  return true;
}

/**
 * Undo deleteCompany. A company suspended before it was deleted comes back
 * suspended (suspended_at survives the delete), never silently reinstated.
 * Returns false when the company does not exist or is not deleted.
 */
export async function restoreCompany(companyId: string): Promise<boolean> {
  // Every CTE reads the same snapshot, so `voided` judges each charge against
  // the period end as it was BEFORE `restarted` moves it.
  const rows = await sql<{ id: string; status: string; voided: string[]; restarted: number }>`
    WITH co AS (
      UPDATE companies
      SET status     = CASE WHEN suspended_at IS NOT NULL THEN 'suspended' ELSE 'active' END,
          updated_at = NOW()
      WHERE id = ${companyId}
        AND status = 'deleted'
      RETURNING id, status
    ), voided AS (
      UPDATE subscription_charges c
      SET status = 'cancelled',
          failure_reason = COALESCE(c.failure_reason, 'company_deleted'),
          updated_at = now()
      FROM subscriptions s, co
      WHERE c.company_id = co.id
        AND s.id = c.subscription_id
        AND s.company_id = c.company_id
        AND c.status IN ('queued','failed')
        AND (s.current_period_end IS NULL
             OR c.period_start >= (s.current_period_end AT TIME ZONE 'UTC')::date)
      RETURNING c.id
    ), restarted AS (
      UPDATE subscriptions s
      SET current_period_end = now(),
          updated_at = now()
      FROM co
      WHERE s.company_id = co.id
        AND s.status IN ('active','past_due')
        AND s.current_period_end < now()
        -- A charge still in flight at Paystack settles into the old period
        -- (advancePeriodForSettledCharge); restarting now would bill today's
        -- period on top of it. Such a subscription resumes as if never deleted.
        AND NOT EXISTS (
          SELECT 1 FROM subscription_charges ic
          WHERE ic.subscription_id = s.id
            AND ic.company_id = s.company_id
            AND ic.status = 'submitted'
        )
      RETURNING s.id
    )
    SELECT co.id, co.status,
           ARRAY(SELECT id::text FROM voided) AS voided,
           (SELECT COUNT(*) FROM restarted)::int AS restarted
    FROM co
  `;
  const row = rows[0];
  if (!row) return false;
  log.info('restoreCompany', {
    companyId, status: row.status, voidedChargeIds: row.voided, restartedSubscriptions: row.restarted,
  }, 'CompanyLifecycle');
  return true;
}
