/**
 * Stale-submission resolver for recurring debits.
 *
 * A charge moves to 'submitted' once Paystack accepts the request, and only a
 * webhook moves it on. If that webhook never arrives — dropped delivery, a
 * signature failure, a response that stayed 'pending' — the charge sits in
 * 'submitted' forever: the retry query ignores it, the close-out defers to it,
 * and the customer is neither billed again nor cancelled. This asks Paystack
 * what actually happened and writes the answer.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { verifyTransaction } from './paystackClient';
import { STALE_SUBMITTED_HOURS, settleSubscriptionCharge } from './subscriptionPeriod';

/** How long one resolver run owns a charge before another may retry it. */
const VERIFY_CLAIM_MINUTES = 10;

/**
 * A live charge that names no subscription cannot be settled — migration 624's
 * CHECK rejects it, and that rejection would land after Paystack had taken the
 * money. `runQueuedCharges` and the resolver both skip such rows; this says so
 * out loud, because the customer is silently not being billed until someone
 * attributes them. 'submitted' is included deliberately: that is the one state
 * where the money has already moved.
 */
export async function warnUnattributedLiveCharges(): Promise<number> {
  const rows = await sql<{ count: number }>`
    SELECT count(*)::int AS count
    FROM subscription_charges
    WHERE gateway = 'paystack'
      AND subscription_id IS NULL
      AND status IN ('queued','submitted','failed')
  `;
  const count = rows[0]?.count ?? 0;
  if (count > 0) {
    log.warn(
      'Live charges name no subscription and will not be debited — attribute them (migration 624)',
      { count },
      'BillingCron',
    );
  }
  return count;
}

export interface ResolveStaleResult {
  settled: number;
  failed: number;
  /** Paystack still has no answer, or a settlement landed mid-verify. */
  pending: number;
  /** Another cron run claimed the charge first. Healthy contention. */
  contended: number;
  /** The verify call itself threw — an integration problem, not a charge one. */
  errored: number;
}

export async function resolveStaleSubmittedCharges(
  now = new Date(),
): Promise<ResolveStaleResult> {
  const cutoff = new Date(now.getTime() - STALE_SUBMITTED_HOURS * 3600_000);

  const stale = await sql<{
    id: string;
    company_id: string;
    paystack_reference: string | null;
    external_reference: string;
  }>`
    SELECT id, company_id, paystack_reference, external_reference
    FROM subscription_charges
    WHERE gateway = 'paystack'
      AND status = 'submitted'
      AND subscription_id IS NOT NULL
      AND last_attempt_at IS NOT NULL
      AND last_attempt_at < ${cutoff.toISOString()}
      AND (verifying_at IS NULL
           OR verifying_at < now() - ${`${VERIFY_CLAIM_MINUTES} minutes`}::interval)
    LIMIT 100
  `;

  let settled = 0;
  let failed = 0;
  let pending = 0;
  let contended = 0;
  let errored = 0;

  for (const c of stale) {
    // Claim it by stamping verifying_at, which the SELECT above filters on, so
    // a run starting moments later does not pick the same charge up at all.
    const claimed = await sql<{ id: string }>`
      UPDATE subscription_charges
      SET verifying_at = now(),
          updated_at = now()
      WHERE id = ${c.id}
        AND status = 'submitted'
        AND (verifying_at IS NULL
             OR verifying_at < now() - ${`${VERIFY_CLAIM_MINUTES} minutes`}::interval)
      RETURNING id
    `;
    if (!claimed[0]) {
      contended++;
      continue;
    }

    const reference = c.paystack_reference ?? c.external_reference;
    try {
      const result = await verifyTransaction(reference);

      if (result.status === 'success') {
        await settleSubscriptionCharge(c.id, c.company_id);
        settled++;
        continue;
      }
      if (result.status === 'pending') {
        pending++;
        continue;
      }

      // Status-predicated: if the missing webhook arrived while we were asking
      // Paystack, the row is already 'settled' and must not be overwritten.
      const marked = await sql<{ id: string }>`
        UPDATE subscription_charges
        SET status = 'failed',
            failure_reason = ${`paystack_${result.status}`},
            updated_at = now()
        WHERE id = ${c.id}
          AND company_id = ${c.company_id}
          AND status = 'submitted'
        RETURNING id
      `;
      if (!marked[0]) {
        // The missing webhook arrived while we were asking. Leave it settled.
        pending++;
        continue;
      }
      failed++;
    } catch (err) {
      errored++;
      log.error(
        'Could not verify a stale subscription debit',
        { chargeId: c.id, companyId: c.company_id, reference,
          msg: err instanceof Error ? err.message : String(err) },
        'BillingCron',
      );
    }
  }

  return { settled, failed, pending, contended, errored };
}
