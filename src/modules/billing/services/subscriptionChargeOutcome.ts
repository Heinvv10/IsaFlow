/**
 * What the cron writes to a charge AFTER its claim, on the migration_admin pool
 * (S-07e), one statement each. All of them refuse a charge that has been
 * voided ('cancelled') meanwhile: an admin cancel can commit between the claim
 * and the end of the Paystack call, and writing 'submitted', 'settled' or
 * 'failed' over it would resurrect a debit the customer was told is void (a
 * 'failed' one would even be retried).
 */

import { log } from '@/lib/logger';
import { migrationAdminSqlTx } from '@/lib/auth/migrationAdminPool';

/**
 * Record the Paystack answer. Returns false when the charge had been voided
 * mid-flight: the card WAS debited (or the debit is pending), nothing local
 * records it, and it is a refund case, so it is logged for a human, not hidden.
 */
export async function recordChargeSubmitted(
  chargeId: string,
  companyId: string,
  localStatus: 'settled' | 'submitted',
  reference: string,
): Promise<boolean> {
  const rows = (await migrationAdminSqlTx('subscription_charge_submitted', (tx) => tx`
    UPDATE subscription_charges
    SET status = ${localStatus},
        settled_at = CASE WHEN ${localStatus} = 'settled' THEN now() ELSE settled_at END,
        updated_at = now()
    WHERE id = ${chargeId}
      AND company_id = ${companyId}
      AND status <> 'cancelled'
    RETURNING id
  `)) as Array<{ id: string }>;
  if (rows.length === 0) {
    log.warn(
      'Card debited for a charge that was voided mid-flight (cancelled after the attempt was claimed); refund needed',
      { chargeId, companyId, reference, localStatus },
      'BillingCron',
    );
    return false;
  }
  return true;
}

/** Record a failed attempt; a charge voided meanwhile stays voided. */
export async function recordChargeFailed(
  chargeId: string,
  companyId: string,
  reason: string,
): Promise<void> {
  await migrationAdminSqlTx('subscription_charge_failed', (tx) => tx`
    UPDATE subscription_charges
    SET status = 'failed',
        failure_reason = ${reason.slice(0, 500)},
        updated_at = now()
    WHERE id = ${chargeId}
      AND company_id = ${companyId}
      AND status <> 'cancelled'
  `);
}
