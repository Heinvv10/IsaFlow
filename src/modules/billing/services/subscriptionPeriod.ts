/**
 * Subscription period transitions — kept out of subscriptionBillingService so
 * the Paystack webhook can settle a charge without importing the cron.
 *
 * Every statement here is keyed on the charge's own subscription_id (migration
 * 624), not on company_id: a company may hold several subscription rows and one
 * charge must only ever move the subscription it was raised for. Charges
 * predating 624 have a NULL subscription_id and are deliberately inert.
 *
 * DATE columns are cast through `AT TIME ZONE 'UTC'` so a period boundary does
 * not shift with the database session's TimeZone.
 *
 * No app role may write subscriptions or subscription_charges (S-07e, migration
 * 945): each function below is ONE migration_admin transaction, keyed on ids the
 * cron or the webhook took from the rows it read.
 */

import type { TxSql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { migrationAdminSqlTx } from '@/lib/auth/migrationAdminPool';

export const MAX_ATTEMPTS = 3;
/** How long a 'submitted' charge may wait for a webhook before it is verified. */
export const STALE_SUBMITTED_HOURS = 24;

/**
 * Move the subscription onto the period the settled charge paid for. The
 * `current_period_end < period_end` guard re-evaluates against the updated row
 * under READ COMMITTED, so the cron and the webhook racing on one charge
 * advance the period exactly once. Settling also clears an earlier past_due.
 */
async function advancePeriod(tx: TxSql, chargeId: string, companyId: string): Promise<void> {
  await tx`
    UPDATE subscriptions s
    SET current_period_start = c.period_start::timestamp AT TIME ZONE 'UTC',
        current_period_end = c.period_end::timestamp AT TIME ZONE 'UTC',
        status = CASE WHEN s.status = 'past_due' THEN 'active' ELSE s.status END,
        updated_at = now()
    FROM subscription_charges c
    WHERE c.id = ${chargeId}
      AND c.company_id = ${companyId}
      AND s.id = c.subscription_id
      AND s.company_id = ${companyId}
      AND s.status <> 'cancelled'
      AND (s.current_period_end IS NULL
           OR s.current_period_end < c.period_end::timestamp AT TIME ZONE 'UTC')
  `;
}

export async function advancePeriodForSettledCharge(
  chargeId: string,
  companyId: string,
): Promise<void> {
  await migrationAdminSqlTx('subscription_advance_period', (tx) => advancePeriod(tx, chargeId, companyId));
}

/**
 * Settle the charge and grant the period it paid for. Used by the webhook and
 * by the stale-charge resolver. A charge voided because the customer cancelled
 * is never resurrected: money that arrives against one is a refund case, not a
 * period, and silently settling it would collect against nothing.
 */
export async function settleSubscriptionCharge(
  chargeId: string,
  companyId: string,
  // The webhook's: what the checkout asked for, and its currency. A charge
  // settles only for at least its own amount, in rand (S-07e); the verify cron
  // passes none, having asked Paystack about the charge's own reference.
  paid?: { cents: number | null; currency?: string },
): Promise<void> {
  if (paid && (paid.cents === null || paid.currency !== 'ZAR')) {
    log.warn('Settlement refused: the payment reported no usable amount, or not in ZAR',
      { chargeId, companyId, paid }, 'BillingCron');
    return;
  }
  const paidCents = paid?.cents ?? null;
  // The charge and its period move together: one transaction.
  const done = await migrationAdminSqlTx('subscription_settle_charge', async (tx) => {
    const settled = (await tx`
      UPDATE subscription_charges
      SET status = 'settled',
          settled_at = COALESCE(settled_at, now()),
          updated_at = now()
      WHERE id = ${chargeId}
        AND company_id = ${companyId}
        AND status <> 'cancelled'
        AND (${paidCents}::bigint IS NULL OR amount_cents <= ${paidCents}::bigint)
      RETURNING id
    `) as Array<{ id: string }>;
    if (!settled[0]) return false;
    await advancePeriod(tx, chargeId, companyId);
    return true;
  });
  if (!done) {
    log.warn(
      'Settlement arrived for a charge that is no longer settleable',
      { chargeId, companyId, paidCents },
      'BillingCron',
    );
  }
}

/**
 * Claim the next attempt on a charge. The predicate is the row state as the
 * caller read it, so of two cron runs that read the same snapshot exactly one
 * claim applies and the other gets null and must leave the charge alone. The
 * RETURNed attempt_count is the only authoritative one.
 */
export async function claimChargeAttempt(
  chargeId: string,
  companyId: string,
  status: string,
  attemptCount: number,
): Promise<number | null> {
  const claimed = (await migrationAdminSqlTx('subscription_claim_attempt', (tx) => tx`
    UPDATE subscription_charges
    SET attempt_count = attempt_count + 1,
        last_attempt_at = now(),
        updated_at = now()
    WHERE id = ${chargeId}
      AND company_id = ${companyId}
      AND status = ${status}
      AND attempt_count = ${attemptCount}
    RETURNING attempt_count
  `)) as Array<{ attempt_count: number }>;
  return claimed[0]?.attempt_count ?? null;
}

/**
 * The attempt just recorded was the last one the retry query will select, so
 * the subscription — active or still on trial — is sitting on a period nobody
 * paid for. `attemptCount` is
 * the value RETURNed by the increment, never a pre-read one, so two overlapping
 * cron runs cannot both believe they wrote the final attempt.
 */
export async function markPastDueIfExhausted(
  chargeId: string,
  companyId: string,
  attemptCount: number,
): Promise<void> {
  if (attemptCount < MAX_ATTEMPTS) return;
  await migrationAdminSqlTx('subscription_past_due', (tx) => tx`
    UPDATE subscriptions s
    SET status = 'past_due',
        updated_at = now()
    FROM subscription_charges c
    WHERE c.id = ${chargeId}
      AND c.company_id = ${companyId}
      AND s.id = c.subscription_id
      AND s.company_id = ${companyId}
      AND s.status IN ('active','trial')
      AND s.current_period_end < c.period_end::timestamp AT TIME ZONE 'UTC'
  `);
}

/**
 * A charge queued for a subscription the customer has since flagged to cancel
 * must not be debited. Only 'queued' and 'failed' rows are voided — 'submitted'
 * means Paystack already has the request, so that one is left to settle and the
 * close-out below waits for it. A charge whose period starts before the
 * boundary the subscription has already been granted is money the customer
 * owes for service taken; cancelling does not write that off.
 */
export async function voidChargesForCancellingSubscriptions(): Promise<number> {
  const voided = (await migrationAdminSqlTx('subscription_void_charges', (tx) => tx`
    UPDATE subscription_charges c
    SET status = 'cancelled',
        failure_reason = COALESCE(c.failure_reason, 'subscription_cancelled_at_period_end'),
        updated_at = now()
    FROM subscriptions s
    WHERE s.id = c.subscription_id
      AND s.company_id = c.company_id
      AND COALESCE(s.cancel_at_period_end, false) = true
      AND c.status IN ('queued','failed')
      AND (s.current_period_end IS NULL
           OR c.period_start >= (s.current_period_end AT TIME ZONE 'UTC')::date)
    RETURNING c.id
  `)) as Array<{ id: string }>;
  return voided.length;
}

/**
 * Close out a subscription whose scheduled cancellation has come due. A
 * subscription with a charge still in flight at Paystack is left alone: the
 * money may yet arrive, and cancelling first would take payment for a period
 * `advancePeriodForSettledCharge` would then refuse to grant.
 */
export async function closeOutCancelledSubscriptions(now: Date): Promise<number> {
  const closed = (await migrationAdminSqlTx('subscription_close_out', (tx) => tx`
    UPDATE subscriptions s
    SET status = 'cancelled',
        cancelled_at = COALESCE(s.cancelled_at, now()),
        updated_at = now()
    WHERE s.status IN ('active','past_due')
      AND COALESCE(s.cancel_at_period_end, false) = true
      AND s.current_period_end IS NOT NULL
      AND s.current_period_end <= ${now}
      AND NOT EXISTS (
        SELECT 1 FROM subscription_charges c
        WHERE c.subscription_id = s.id
          AND c.company_id = s.company_id
          AND c.status IN ('queued','submitted')
      )
    RETURNING s.id
  `)) as Array<{ id: string }>;
  return closed.length;
}
