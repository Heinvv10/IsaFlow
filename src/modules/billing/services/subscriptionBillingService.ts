/**
 * Subscription billing service — recurring SaaS debits via Paystack.
 *
 *   generateDueCharges()  — queue a charge for every active subscription whose
 *                           current_period_end has passed and that has no
 *                           unsettled charge for the next period, then close
 *                           out subscriptions flagged cancel_at_period_end.
 *                           The reads are planDueCharges (subscriptionChargePlan);
 *                           a paid subscription with no active mandate is
 *                           counted and listed as unbilledNoMandate, never
 *                           folded into skipped.
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
 *
 * Every write to subscription_charges, and the one read of the mandate's card
 * codes, runs on the migration_admin pool (S-07e, migration 945): app roles
 * can neither write those tables nor read the codes a charge is made with. A
 * migration_admin transaction is held for a single statement, never across the
 * Paystack call.
 */

import { randomBytes } from 'crypto';
import { log } from '@/lib/logger';
import { migrationAdminSqlTx } from '@/lib/auth/migrationAdminPool';
import { recordChargePaymentRequest } from './subscriptionChargeRequest';
import { recordChargeFailed, recordChargeSubmitted } from './subscriptionChargeOutcome';
import { chargeAuthorization } from './paystackClient';
import { warnUnattributedLiveCharges } from './subscriptionChargeVerify';
import { planDueCharges, selectChargeableCharges } from './subscriptionChargePlan';
import {
  advancePeriodForSettledCharge,
  claimChargeAttempt,
  closeOutCancelledSubscriptions,
  markPastDueIfExhausted,
  voidChargesForCancellingSubscriptions,
} from './subscriptionPeriod';

/** Most unbilled subscriptions listed in one result; the count is never capped. */
export const UNBILLED_LIST_CAP = 50;

export interface UnbilledSubscription {
  companyId: string;
  subscriptionId: string;
  currentPeriodEnd: string;
  daysOverdue: number;
}

export interface GenerateResult {
  created: number;
  /** Free plans and periods that already have a charge. */
  skipped: number;
  /**
   * Paid subscriptions past their period end with no active Paystack mandate:
   * no charge is raised, so they are never billed until a mandate exists.
   */
  unbilledNoMandate: number;
  /** The first UNBILLED_LIST_CAP of them. */
  unbilled: UnbilledSubscription[];
  /** Subscriptions closed out because their scheduled cancellation came due. */
  cancelled: number;
  /** Queued debits voided because the customer scheduled a cancellation. */
  voided: number;
}

export async function generateDueCharges(now = new Date()): Promise<GenerateResult> {
  const plan = await planDueCharges(now);

  let created = 0;
  let skipped = 0;
  let unbilledNoMandate = 0;
  const unbilled: UnbilledSubscription[] = [];

  for (const item of plan) {
    if (item.outcome === 'unbilled_no_mandate') {
      unbilledNoMandate++;
      if (unbilled.length < UNBILLED_LIST_CAP) {
        unbilled.push({
          companyId: item.companyId,
          subscriptionId: item.subscriptionId,
          currentPeriodEnd: item.currentPeriodEnd,
          daysOverdue: item.daysOverdue,
        });
      }
      log.warn(
        'Paid subscription not billed: no active Paystack mandate',
        {
          reason: 'unbilled_no_mandate',
          companyId: item.companyId,
          subscriptionId: item.subscriptionId,
          daysOverdue: item.daysOverdue,
        },
        'BillingCron',
      );
      continue;
    }
    if (item.outcome !== 'create' || !item.mandateId) {
      skipped++;
      continue;
    }

    const reference = `sub_${item.companyId.replace(/-/g, '').slice(0, 12)}_${item.periodStart.slice(0, 7)}_${randomBytes(4).toString('hex')}`;

    await migrationAdminSqlTx('subscription_queue_charge', (tx) => tx`
      INSERT INTO subscription_charges (
        company_id, subscription_id, mandate_id, period_start, period_end,
        amount_cents, currency, gateway,
        external_reference, paystack_reference, status
      ) VALUES (
        ${item.companyId}, ${item.subscriptionId}, ${item.mandateId},
        ${item.periodStart},
        ${item.periodEnd},
        ${item.amountCents}, 'ZAR', 'paystack',
        ${reference}, ${reference}, 'queued'
      )
    `);

    created++;
  }

  // A charge already queued for a subscription the customer has flagged to
  // cancel must be voided before the close-out, or the same cron run would
  // cancel the subscription and still debit the card for it.
  const voided = await voidChargesForCancellingSubscriptions();
  const cancelled = await closeOutCancelledSubscriptions(now);

  return { created, skipped, unbilledNoMandate, unbilled, cancelled, voided };
}

export interface RunChargesResult {
  submitted: number;
  /** Card debited for a charge an admin voided mid-flight: a refund case, not a submission. */
  refundNeeded: number;
  failed: number;
  skipped: number;
}

export async function runQueuedCharges(now = new Date()): Promise<RunChargesResult> {
  const charges = await selectChargeableCharges(now);

  await warnUnattributedLiveCharges();

  let submitted = 0;
  let refundNeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const c of charges) {
    // Claim the attempt before spending it, so a concurrent run that read the
    // same snapshot cannot also charge this card.
    const attemptCount = await claimChargeAttempt(c.id, c.company_id, c.status, c.attempt_count);
    if (attemptCount === null) {
      skipped++;
      continue;
    }

    if (
      c.mandate_status !== 'active' ||
      !c.paystack_authorization_code ||
      !c.user_email
    ) {
      await recordChargeFailed(c.id, c.company_id, 'mandate_not_active_or_missing_authorization');
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

      await recordChargePaymentRequest(c.company_id, c.id, result.reference, Number(c.amount_cents), result.status === 'success');

      // Optimistically reflect immediate success — the webhook is still
      // authoritative and will overwrite if the bank reverses.
      const localStatus = result.status === 'success' ? 'settled' : 'submitted';
      const recorded = await recordChargeSubmitted(c.id, c.company_id, localStatus, result.reference);
      if (!recorded) {
        refundNeeded++;
        continue;
      }
      if (localStatus === 'settled') {
        await advancePeriodForSettledCharge(c.id, c.company_id);
      }

      submitted++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await recordChargeFailed(c.id, c.company_id, msg);
      await markPastDueIfExhausted(c.id, c.company_id, attemptCount);
      failed++;
      log.error(
        'Subscription debit failed',
        { chargeId: c.id, companyId: c.company_id, msg },
        'BillingCron',
      );
    }
  }

  return { submitted, refundNeeded, failed, skipped };
}
