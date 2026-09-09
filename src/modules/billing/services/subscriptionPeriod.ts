/**
 * Subscription period transitions — kept out of subscriptionBillingService so
 * the Paystack webhook can advance a period without importing the cron.
 */

import { sql } from '@/lib/neon';

export const MAX_ATTEMPTS = 3;

/**
 * Move the subscription onto the period the settled charge paid for. Keyed off
 * the charge row so the cron and the webhook are idempotent in any order: the
 * period only moves forward, and settling clears an earlier past_due.
 */
export async function advancePeriodForSettledCharge(
  chargeId: string,
  companyId: string,
): Promise<void> {
  await sql`
    UPDATE subscriptions s
    SET current_period_start = c.period_start,
        current_period_end = c.period_end,
        status = CASE WHEN s.status = 'past_due' THEN 'active' ELSE s.status END,
        updated_at = now()
    FROM subscription_charges c
    WHERE c.id = ${chargeId}
      AND c.company_id = ${companyId}
      AND s.company_id = ${companyId}
      AND s.status <> 'cancelled'
      AND (s.current_period_end IS NULL OR s.current_period_end < c.period_end)
  `;
}

/** Last attempt the retry query will select — the period is unpaid, so flag it. */
export async function markPastDueIfExhausted(
  companyId: string,
  attemptCountBefore: number,
): Promise<void> {
  if (attemptCountBefore + 1 < MAX_ATTEMPTS) return;
  await sql`
    UPDATE subscriptions
    SET status = 'past_due',
        updated_at = now()
    WHERE company_id = ${companyId}
      AND status = 'active'
  `;
}
