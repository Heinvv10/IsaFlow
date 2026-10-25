/**
 * The Paystack webhook's failure events: `charge.failed` / `invoice.payment_failed`
 * fail the payment request and, when its checkout metadata names the same
 * billing row (paystackLinkBinding.ts), the Flow purchase or the subscription
 * charge; `subscription.disable` revokes the mandate holding that Paystack
 * subscription. The billing writes run on migration_admin, joined to the
 * event's transaction (S-07e, publicRouteTx.ts); each is idempotent, so a
 * redelivery after a lost service-pool COMMIT changes nothing.
 */
import { sql } from '@/lib/neon';
import { migrationAdminSqlTx } from '@/lib/auth/migrationAdminPool';
import { failBundlePurchase } from './flowWalletService';
import { linkMismatch, logRefusedLink } from './paystackLinkBinding';

export async function handleChargeFailed(
  reference: string,
  reason: string,
  metadata: Record<string, unknown> | undefined,
): Promise<void> {
  const prRows = await sql<{
    id: string;
    company_id: string;
    purpose: string;
    flow_purchase_id: string | null;
    subscription_charge_id: string | null;
    mandate_id: string | null;
  }>`
    UPDATE paystack_payment_requests
    SET status = 'failed',
        failure_reason = ${reason}
    WHERE paystack_reference = ${reference}
      AND status NOT IN ('completed','failed')
    RETURNING id, company_id, purpose, flow_purchase_id, subscription_charge_id, mandate_id
  `;
  const pr = prRows[0];
  if (!pr) return;

  // A failure the checkout's own metadata does not tie to this billing row
  // fails only the request: it must not fail someone else's purchase or burn
  // someone else's charge attempts.
  const mismatch = linkMismatch(pr, metadata);
  if (mismatch) {
    logRefusedLink(reference, pr, mismatch);
    return;
  }

  if (pr.purpose === 'flow_bundle' && pr.flow_purchase_id) {
    await failBundlePurchase(pr.flow_purchase_id, reason, pr.company_id);
  }
  if (pr.purpose === 'subscription_charge' && pr.subscription_charge_id) {
    // Only a charge still in flight: a redelivered failure, or one for a charge
    // already settled or cancelled, counts no further attempt.
    await migrationAdminSqlTx('paystack_charge_failed', (tx) => tx`
      UPDATE subscription_charges
      SET status = 'failed',
          failure_reason = ${reason},
          attempt_count = attempt_count + 1,
          last_attempt_at = now(),
          updated_at = now()
      WHERE id = ${pr.subscription_charge_id}
        AND company_id = ${pr.company_id}
        AND status NOT IN ('failed', 'settled', 'cancelled')
    `);
  }
}

export async function handleSubscriptionDisabled(subscriptionCode: string): Promise<void> {
  await migrationAdminSqlTx('paystack_subscription_disabled', (tx) => tx`
    UPDATE subscription_mandates
    SET status = 'revoked',
        revoked_at = COALESCE(revoked_at, now()),
        revoked_reason = 'paystack_subscription_disabled',
        updated_at = now()
    WHERE paystack_subscription_code = ${subscriptionCode}
      AND status NOT IN ('revoked','expired')
  `);
}
