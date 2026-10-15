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
 * - restore starts a new period from the restore date: a subscription whose
 *   period ended while the company was deleted gets current_period_end = now,
 *   so the next cron raises one charge from today instead of one per missed
 *   cycle.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

export async function deleteCompany(companyId: string): Promise<void> {
  const voided = await sql<{ id: string }>`
    WITH co AS (
      UPDATE companies
      SET status     = 'deleted',
          updated_at = NOW()
      WHERE id = ${companyId}
      RETURNING id
    )
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
  `;
  log.info('deleteCompany (soft)', { companyId, voidedCharges: voided.length }, 'CompanyLifecycle');
}

/**
 * Undo deleteCompany. A company suspended before it was deleted comes back
 * suspended (suspended_at survives the delete), never silently reinstated.
 * Returns false when the company does not exist or is not deleted.
 */
export async function restoreCompany(companyId: string): Promise<boolean> {
  const rows = await sql<{ id: string; status: string; restarted: number }>`
    WITH co AS (
      UPDATE companies
      SET status     = CASE WHEN suspended_at IS NOT NULL THEN 'suspended' ELSE 'active' END,
          updated_at = NOW()
      WHERE id = ${companyId}
        AND status = 'deleted'
      RETURNING id, status
    ), restarted AS (
      UPDATE subscriptions s
      SET current_period_end = now(),
          updated_at = now()
      FROM co
      WHERE s.company_id = co.id
        AND s.status IN ('active','past_due')
        AND s.current_period_end < now()
      RETURNING s.id
    )
    SELECT co.id, co.status, (SELECT COUNT(*) FROM restarted)::int AS restarted
    FROM co
  `;
  const row = rows[0];
  if (!row) return false;
  log.info('restoreCompany', { companyId, status: row.status, restartedSubscriptions: row.restarted }, 'CompanyLifecycle');
  return true;
}
