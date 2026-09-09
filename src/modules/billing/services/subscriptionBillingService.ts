/**
 * Subscription billing service — recurring SaaS debits via Paystack.
 *
 *   generateDueCharges()  — queue a charge for every active subscription whose
 *                           current_period_end has passed and that has no
 *                           unsettled charge for the next period, then close
 *                           out subscriptions flagged cancel_at_period_end.
 *
 *   runQueuedCharges()    — claim each retry-eligible charge, call Paystack
 *                           chargeAuthorization() against the company's active
 *                           mandate and record a paystack_payment_requests row
 *                           so the webhook can settle it.
 *
 * The period moves forward only when a charge settles (see subscriptionPeriod),
 * never when it is queued; a charge that burns every attempt leaves the
 * subscription 'past_due'. All writes are company-scoped and keyed on the
 * charge's subscription_id. The mandate must be 'active' AND have a
 * paystack_authorization_code, or the charge fails with 'no_mandate'.
 */

import { randomBytes } from 'crypto';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { chargeAuthorization } from './paystackClient';
import {
  MAX_ATTEMPTS,
  advancePeriodForSettledCharge,
  claimChargeAttempt,
  closeOutCancelledSubscriptions,
  markPastDueIfExhausted,
  voidChargesForCancellingSubscriptions,
} from './subscriptionPeriod';

const RETRY_BACKOFF_HOURS = 24;

export interface GenerateResult {
  created: number;
  skipped: number;
  /** Subscriptions closed out because their scheduled cancellation came due. */
  cancelled: number;
  /** Queued debits voided because the customer scheduled a cancellation. */
  voided: number;
}

export async function generateDueCharges(now = new Date()): Promise<GenerateResult> {
  const dueSubs = await sql<{
    company_id: string;
    subscription_id: string;
    plan_id: string;
    billing_cycle: 'monthly' | 'annual';
    current_period_start: Date | string;
    current_period_end: Date | string;
    discount_percent: number | null;
    monthly_price_cents: number;
    annual_price_cents: number;
  }>`
    SELECT s.company_id, s.id AS subscription_id, s.plan_id, s.billing_cycle,
           s.current_period_start, s.current_period_end, s.discount_percent,
           p.monthly_price_cents, p.annual_price_cents
    FROM subscriptions s
    JOIN plans p ON p.id = s.plan_id
    WHERE s.status IN ('active','past_due')
      AND COALESCE(s.cancel_at_period_end, false) = false
      AND s.current_period_end IS NOT NULL
      AND s.current_period_end <= ${now}
  `;

  let created = 0;
  let skipped = 0;

  for (const sub of dueSubs) {
    const periodEnd = new Date(sub.current_period_end);
    const nextStart = new Date(periodEnd);
    const nextEnd = new Date(periodEnd);
    if (sub.billing_cycle === 'annual') {
      nextEnd.setFullYear(nextEnd.getFullYear() + 1);
    } else {
      nextEnd.setMonth(nextEnd.getMonth() + 1);
    }

    const grossCents = sub.billing_cycle === 'annual'
      ? sub.annual_price_cents
      : sub.monthly_price_cents;
    const discount = sub.discount_percent ?? 0;
    const amountCents = Math.round(grossCents * (100 - discount) / 100);

    if (amountCents <= 0) {
      skipped++;
      continue;
    }

    const existing = await sql<{ id: string }>`
      SELECT id FROM subscription_charges
      WHERE company_id = ${sub.company_id}
        -- A row predating migration 624 names no subscription. Treating it as
        -- someone else's would queue a replacement, and both would settle.
        AND (subscription_id = ${sub.subscription_id} OR subscription_id IS NULL)
        AND period_start = ${nextStart.toISOString().slice(0, 10)}
        AND period_end = ${nextEnd.toISOString().slice(0, 10)}
        AND status <> 'cancelled'
      LIMIT 1
    `;
    if (existing[0]) {
      skipped++;
      continue;
    }

    const mandate = await sql<{ id: string }>`
      SELECT id FROM subscription_mandates
      WHERE company_id = ${sub.company_id}
        AND gateway = 'paystack'
        AND status = 'active'
      LIMIT 1
    `;
    if (!mandate[0]) {
      skipped++;
      log.warn(
        'Skipping charge generation — no active Paystack mandate',
        { companyId: sub.company_id, subscriptionId: sub.subscription_id },
        'BillingCron',
      );
      continue;
    }

    const reference = `sub_${sub.company_id.replace(/-/g, '').slice(0, 12)}_${nextStart.toISOString().slice(0, 7)}_${randomBytes(4).toString('hex')}`;

    await sql`
      INSERT INTO subscription_charges (
        company_id, subscription_id, mandate_id, period_start, period_end,
        amount_cents, currency, gateway,
        external_reference, paystack_reference, status
      ) VALUES (
        ${sub.company_id}, ${sub.subscription_id}, ${mandate[0].id},
        ${nextStart.toISOString().slice(0, 10)},
        ${nextEnd.toISOString().slice(0, 10)},
        ${amountCents}, 'ZAR', 'paystack',
        ${reference}, ${reference}, 'queued'
      )
    `;

    created++;
  }

  // A charge already queued for a subscription the customer has flagged to
  // cancel must be voided before the close-out, or the same cron run would
  // cancel the subscription and still debit the card for it.
  const voided = await voidChargesForCancellingSubscriptions();
  const cancelled = await closeOutCancelledSubscriptions(now);

  return { created, skipped, cancelled, voided };
}

export interface RunChargesResult {
  submitted: number;
  failed: number;
  skipped: number;
}

export async function runQueuedCharges(now = new Date()): Promise<RunChargesResult> {
  const cutoff = new Date(now.getTime() - RETRY_BACKOFF_HOURS * 3600_000);

  const charges = await sql<{
    id: string;
    company_id: string;
    mandate_id: string;
    amount_cents: string;
    paystack_reference: string | null;
    external_reference: string;
    attempt_count: number;
    status: 'queued' | 'failed';
    paystack_authorization_code: string | null;
    paystack_customer_code: string | null;
    mandate_status: string;
    user_email: string | null;
    period_start: Date | string;
    period_end: Date | string;
  }>`
    SELECT c.id, c.company_id, c.mandate_id, c.amount_cents,
           c.paystack_reference, c.external_reference, c.attempt_count, c.status,
           c.period_start, c.period_end,
           m.paystack_authorization_code, m.paystack_customer_code,
           m.status AS mandate_status,
           u.email AS user_email
    FROM subscription_charges c
    JOIN subscription_mandates m ON m.id = c.mandate_id
    LEFT JOIN users u ON u.id = m.authorised_by
    WHERE c.gateway = 'paystack'
      AND (c.status = 'queued'
           OR (c.status = 'failed' AND c.last_attempt_at < ${cutoff.toISOString()}))
      AND c.attempt_count < ${MAX_ATTEMPTS}
    LIMIT 100
  `;

  let submitted = 0;
  let failed = 0;
  let skipped = 0;

  for (const c of charges) {
    // Claim the attempt before spending it, so a concurrent run that read the
    // same snapshot cannot also charge this card.
    const attemptCount = await claimChargeAttempt(c.id, c.status, c.attempt_count);
    if (attemptCount === null) {
      skipped++;
      continue;
    }

    if (
      c.mandate_status !== 'active' ||
      !c.paystack_authorization_code ||
      !c.user_email
    ) {
      await sql`
        UPDATE subscription_charges
        SET status = 'failed',
            failure_reason = 'mandate_not_active_or_missing_authorization',
            updated_at = now()
        WHERE id = ${c.id}
      `;
      await markPastDueIfExhausted(c.id, c.company_id, attemptCount);
      skipped++;
      continue;
    }

    const reference = c.paystack_reference ?? c.external_reference;

    try {
      const result = await chargeAuthorization({
        authorizationCode: c.paystack_authorization_code,
        email: c.user_email,
        amountCents: Number(c.amount_cents),
        reference,
        metadata: {
          purpose: 'subscription_charge',
          company_id: c.company_id,
          subscription_charge_id: c.id,
          period_start: String(c.period_start).slice(0, 10),
        },
      });

      // Record a paystack_payment_requests row so the webhook can finalise.
      await sql`
        INSERT INTO paystack_payment_requests (
          company_id, purpose, subscription_charge_id,
          paystack_reference, paystack_authorization_code,
          paystack_customer_code,
          amount_cents, currency,
          status
        ) VALUES (
          ${c.company_id}, 'subscription_charge', ${c.id},
          ${result.reference}, ${c.paystack_authorization_code},
          ${c.paystack_customer_code},
          ${Number(c.amount_cents)}, 'ZAR',
          ${result.status === 'success' ? 'completed' : 'pending'}
        )
        ON CONFLICT (paystack_reference) DO NOTHING
      `;

      // Optimistically reflect immediate success — the webhook is still
      // authoritative and will overwrite if the bank reverses.
      const localStatus = result.status === 'success' ? 'settled' : 'submitted';
      await sql`
        UPDATE subscription_charges
        SET status = ${localStatus},
            settled_at = CASE WHEN ${localStatus} = 'settled' THEN now() ELSE settled_at END,
            updated_at = now()
        WHERE id = ${c.id}
      `;

      if (localStatus === 'settled') {
        await advancePeriodForSettledCharge(c.id, c.company_id);
      }

      submitted++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await sql`
        UPDATE subscription_charges
        SET status = 'failed',
            failure_reason = ${msg.slice(0, 500)},
            updated_at = now()
        WHERE id = ${c.id}
      `;
      await markPastDueIfExhausted(c.id, c.company_id, attemptCount);
      failed++;
      log.error(
        'Subscription debit failed',
        { chargeId: c.id, companyId: c.company_id, msg },
        'BillingCron',
      );
    }
  }

  return { submitted, failed, skipped };
}
