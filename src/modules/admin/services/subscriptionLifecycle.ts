/**
 * Admin subscription transitions: edit (PATCH) and cancel.
 *
 * Every status change here keeps the subscription's open charges consistent in
 * the SAME admin transaction (see subscriptionChargeVoid.ts for the rule): the
 * row is locked first, so a charge-attempt claim (subscriptionPeriod.ts, FOR
 * SHARE on the subscription) waits for the change to commit and then sees it.
 * Lock order is subscription row -> charge rows on every path that holds both:
 * this file (admin cancel / reactivation), the attempt claim, the webhook settle
 * (settleSubscriptionCharge, FOR UPDATE on the subscription first) and
 * restoreCompany, so a cancel racing a settle or a restore cannot deadlock.
 * Paths that write only charges (deleteCompany, the cron voids, the runner's
 * outcome writes) hold no subscription lock and so cannot close a cycle.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { voidOpenChargesForSubscription } from './subscriptionChargeVoid';

/** Statuses an admin may set. 'paused' is DB-valid but not settable here; 'suspended' is not DB-valid. */
const ALLOWED_STATUSES = ['active', 'trial', 'past_due', 'cancelled'];

async function lockStatus(subscriptionId: string): Promise<string | null> {
  const rows = (await sql`
    SELECT status FROM subscriptions WHERE id = ${subscriptionId} FOR UPDATE
  `) as Array<{ status: string }>;
  return rows[0]?.status ?? null;
}

/**
 * A subscription cancelled long ago keeps its old current_period_end, so
 * reactivating it would have the cron raise one charge per missed cycle. Start
 * a new period from today instead (restoreCompany does the same for the end):
 * the next run raises one charge from today. current_period_start moves too,
 * or the admin billing tab, the subscriptions list and the CSV export, which
 * all show it, would display a period of months. Not restarted while a charge
 * is 'submitted' at Paystack: it settles into the old period.
 */
async function restartLapsedPeriod(subscriptionId: string): Promise<void> {
  await sql`
    UPDATE subscriptions s
    SET current_period_start = NOW(), current_period_end = NOW(), updated_at = NOW()
    WHERE s.id = ${subscriptionId}
      AND s.current_period_end < NOW()
      AND NOT EXISTS (
        SELECT 1 FROM subscription_charges c
        WHERE c.subscription_id = s.id AND c.company_id = s.company_id AND c.status = 'submitted')
  `;
}

export async function updateSubscription(
  subscriptionId: string,
  data: {
    plan_id?: string;
    billing_cycle?: string;
    discount_percent?: number;
    status?: string;
    notes?: string;
  }
): Promise<void> {
  const { plan_id, billing_cycle, discount_percent, status, notes } = data;
  if (status && !ALLOWED_STATUSES.includes(status)) {
    throw new Error(`Invalid subscription status: ${status}`);
  }

  if (status) {
    const before = await lockStatus(subscriptionId);
    // Charges left open by a cancel made before charges were voided with it
    // would be debited the moment the subscription is active again.
    if (before === 'cancelled' && status !== 'cancelled') {
      await voidOpenChargesForSubscription(subscriptionId);
      await restartLapsedPeriod(subscriptionId);
    }
  }

  await sql`
    UPDATE subscriptions SET
      plan_id          = COALESCE(${plan_id ?? null}::uuid, plan_id),
      billing_cycle    = COALESCE(${billing_cycle ?? null}, billing_cycle),
      discount_percent = COALESCE(${discount_percent ?? null}, discount_percent),
      status           = COALESCE(${status ?? null}, status),
      notes            = COALESCE(${notes ?? null}, notes),
      -- A real transition back into active/trial clears the scheduled
      -- cancellation, or the cron would cancel the subscription again at the
      -- end of the period. An edit that merely restates the current status
      -- must not silently un-cancel it.
      cancel_at_period_end = CASE
        WHEN ${status ?? null}::text IN ('active','trial')
             AND status NOT IN ('active','trial') THEN false
        ELSE cancel_at_period_end
      END,
      -- Churn reads cancelled_at: stamp it on the transition into cancelled,
      -- keep it when cancelled is restated, clear it on reactivation.
      cancelled_at = CASE
        WHEN ${status ?? null}::text = 'cancelled' THEN
          CASE WHEN status = 'cancelled' THEN COALESCE(cancelled_at, NOW()) ELSE NOW() END
        WHEN ${status ?? null}::text IS NOT NULL AND status = 'cancelled' THEN NULL
        ELSE cancelled_at
      END,
      updated_at       = NOW()
    WHERE id = ${subscriptionId}
  `;
  if (status === 'cancelled') await voidOpenChargesForSubscription(subscriptionId);

  log.info('updateSubscription', { subscriptionId }, 'BillingService');
}

export async function cancelSubscription(
  subscriptionId: string,
  atPeriodEnd: boolean
): Promise<void> {
  if (atPeriodEnd) {
    await sql`
      UPDATE subscriptions
      SET cancel_at_period_end = true,
          updated_at           = NOW()
      WHERE id = ${subscriptionId}
    `;
  } else {
    await sql`
      UPDATE subscriptions
      SET status       = 'cancelled',
          -- Cancelling an already cancelled subscription must not move its churn month.
          cancelled_at = CASE WHEN status = 'cancelled' THEN COALESCE(cancelled_at, NOW()) ELSE NOW() END,
          updated_at   = NOW()
      WHERE id = ${subscriptionId}
    `;
    await voidOpenChargesForSubscription(subscriptionId);
  }
  log.info('cancelSubscription', { subscriptionId, atPeriodEnd }, 'BillingService');
}
