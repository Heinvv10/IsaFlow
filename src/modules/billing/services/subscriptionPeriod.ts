/**
 * Subscription period transitions — kept out of subscriptionBillingService so
 * the Paystack webhook can settle a charge without importing the cron.
 *
 * Every statement here is keyed on the charge's own subscription_id (migration
 * 619), not on company_id: a company may hold several subscription rows and one
 * charge must only ever move the subscription it was raised for. Charges
 * predating 619 have a NULL subscription_id and are deliberately inert.
 *
 * DATE columns are cast through `AT TIME ZONE 'UTC'` so a period boundary does
 * not shift with the database session's TimeZone.
 */

import { sql } from '@/lib/neon';

export const MAX_ATTEMPTS = 3;

/**
 * Move the subscription onto the period the settled charge paid for. The
 * `current_period_end < period_end` guard re-evaluates against the updated row
 * under READ COMMITTED, so the cron and the webhook racing on one charge
 * advance the period exactly once. Settling also clears an earlier past_due.
 */
export async function advancePeriodForSettledCharge(
  chargeId: string,
  companyId: string,
): Promise<void> {
  await sql`
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

/** Settle the charge and grant the period it paid for. Used by the webhook. */
export async function settleSubscriptionCharge(
  chargeId: string,
  companyId: string,
): Promise<void> {
  await sql`
    UPDATE subscription_charges
    SET status = 'settled',
        settled_at = COALESCE(settled_at, now()),
        updated_at = now()
    WHERE id = ${chargeId} AND company_id = ${companyId}
  `;
  await advancePeriodForSettledCharge(chargeId, companyId);
}

/**
 * Claim the next attempt on a charge. The predicate is the row state as the
 * caller read it, so of two cron runs that read the same snapshot exactly one
 * claim applies and the other gets null and must leave the charge alone. The
 * RETURNed attempt_count is the only authoritative one.
 */
export async function claimChargeAttempt(
  chargeId: string,
  status: string,
  attemptCount: number,
): Promise<number | null> {
  const claimed = await sql<{ attempt_count: number }>`
    UPDATE subscription_charges
    SET attempt_count = attempt_count + 1,
        last_attempt_at = now(),
        updated_at = now()
    WHERE id = ${chargeId}
      AND status = ${status}
      AND attempt_count = ${attemptCount}
    RETURNING attempt_count
  `;
  return claimed[0]?.attempt_count ?? null;
}

/**
 * The attempt just recorded was the last one the retry query will select, so
 * the subscription is sitting on a period nobody paid for. `attemptCount` is
 * the value RETURNed by the increment, never a pre-read one, so two overlapping
 * cron runs cannot both believe they wrote the final attempt.
 */
export async function markPastDueIfExhausted(
  chargeId: string,
  companyId: string,
  attemptCount: number,
): Promise<void> {
  if (attemptCount < MAX_ATTEMPTS) return;
  await sql`
    UPDATE subscriptions s
    SET status = 'past_due',
        updated_at = now()
    FROM subscription_charges c
    WHERE c.id = ${chargeId}
      AND c.company_id = ${companyId}
      AND s.id = c.subscription_id
      AND s.company_id = ${companyId}
      AND s.status = 'active'
      AND s.current_period_end < c.period_end::timestamp AT TIME ZONE 'UTC'
  `;
}

/**
 * A charge queued for a subscription the customer has since flagged to cancel
 * must not be debited. Only 'queued' and 'failed' rows are voided — 'submitted'
 * means Paystack already has the request, so that one is left to settle and the
 * close-out below waits for it.
 */
export async function voidChargesForCancellingSubscriptions(): Promise<number> {
  const voided = await sql<{ id: string }>`
    UPDATE subscription_charges c
    SET status = 'cancelled',
        failure_reason = COALESCE(c.failure_reason, 'subscription_cancelled_at_period_end'),
        updated_at = now()
    FROM subscriptions s
    WHERE s.id = c.subscription_id
      AND s.company_id = c.company_id
      AND COALESCE(s.cancel_at_period_end, false) = true
      AND c.status IN ('queued','failed')
    RETURNING c.id
  `;
  return voided.length;
}

/**
 * Close out a subscription whose scheduled cancellation has come due. A
 * subscription with a charge still in flight at Paystack is left alone: the
 * money may yet arrive, and cancelling first would take payment for a period
 * `advancePeriodForSettledCharge` would then refuse to grant.
 */
export async function closeOutCancelledSubscriptions(now: Date): Promise<number> {
  const closed = await sql<{ id: string }>`
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
  `;
  return closed.length;
}
