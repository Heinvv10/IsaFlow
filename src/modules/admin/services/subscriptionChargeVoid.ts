/**
 * Void the debits a subscription still has open when an admin ends it.
 *
 * An immediate cancel (or PATCH status 'cancelled') used to touch the
 * subscription row only, so a charge already 'queued', or 'failed' and past its
 * retry backoff, was still debited by runQueuedCharges() for a period
 * advancePeriod refuses to grant a cancelled subscription. This runs in the
 * admin request's own transaction (platform_admin may UPDATE
 * subscription_charges, migration 945), so the cancel and the void commit or
 * roll back together.
 *
 * 'submitted' is left alone: Paystack already has that request and the money
 * may yet arrive, which is a refund case, not something to void locally.
 * Keyed on the subscription's own id and its company, never on company alone.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

export async function voidOpenChargesForSubscription(subscriptionId: string): Promise<number> {
  const voided = await sql`
    UPDATE subscription_charges c
    SET status = 'cancelled',
        failure_reason = COALESCE(c.failure_reason, 'subscription_cancelled_by_admin'),
        updated_at = NOW()
    FROM subscriptions s
    WHERE s.id = ${subscriptionId}
      AND c.subscription_id = s.id
      AND c.company_id = s.company_id
      AND c.status IN ('queued', 'failed')
    RETURNING c.id
  `;
  if (voided.length > 0) {
    log.info('Voided open charges for cancelled subscription',
      { subscriptionId, voided: voided.length }, 'BillingService');
  }
  return voided.length;
}
