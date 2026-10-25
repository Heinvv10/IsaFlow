/**
 * The payment request the subscription-charge cron records for a charge it
 * just made, so the webhook can settle it. Not the card's codes: that table is
 * app-readable (S-07e, migration 945).
 *
 * The reference is the charge's own, which app roles can read; a row an app
 * role inserted under it first is not the cron's. ON CONFLICT then writes
 * nothing, and the webhook's link binding (paystackLinkBinding.ts) refuses that
 * row for this payment, so it is logged here at error level: the charge is
 * settled by the stale-charge resolver instead, which asks Paystack about the
 * charge's own reference.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

export async function recordChargePaymentRequest(
  companyId: string,
  chargeId: string,
  reference: string,
  amountCents: number,
  succeeded: boolean,
): Promise<void> {
  const inserted = await sql<{ id: string }>`
    INSERT INTO paystack_payment_requests (
      company_id, purpose, subscription_charge_id, paystack_reference, amount_cents, currency, status
    ) VALUES (
      ${companyId}, 'subscription_charge', ${chargeId}, ${reference}, ${amountCents}, 'ZAR',
      ${succeeded ? 'completed' : 'pending'}
    )
    ON CONFLICT (paystack_reference) DO NOTHING
    RETURNING id
  `;
  if (inserted.length > 0) return;
  const existing = await sql<{ purpose: string; company_id: string; subscription_charge_id: string | null }>`
    SELECT purpose, company_id, subscription_charge_id FROM paystack_payment_requests WHERE paystack_reference = ${reference} LIMIT 1
  `;
  const row = existing[0];
  if (row && row.purpose === 'subscription_charge' && row.company_id === companyId && row.subscription_charge_id === chargeId) {
    return; // the cron's own row, from an earlier attempt on this reference
  }
  log.error('subscription charge reference already holds another payment request; the webhook will not settle through it', {
    chargeId, companyId, reference, heldBy: row ?? null,
  }, 'BillingCron');
}
