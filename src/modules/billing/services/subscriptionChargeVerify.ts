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

export interface ResolveStaleResult {
  settled: number;
  failed: number;
  /** Still pending at Paystack, or the verify call itself failed. */
  unresolved: number;
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
    updated_at_text: string;
  }>`
    SELECT id, company_id, paystack_reference, external_reference,
           updated_at::text AS updated_at_text
    FROM subscription_charges
    WHERE gateway = 'paystack'
      AND status = 'submitted'
      AND last_attempt_at IS NOT NULL
      AND last_attempt_at < ${cutoff.toISOString()}
    LIMIT 100
  `;

  let settled = 0;
  let failed = 0;
  let unresolved = 0;

  for (const c of stale) {
    // Claim it: a second cron run holding the same snapshot gets nothing back
    // and leaves the charge alone rather than verifying it in parallel.
    const claimed = await sql<{ id: string }>`
      UPDATE subscription_charges
      SET updated_at = now()
      WHERE id = ${c.id}
        AND status = 'submitted'
        AND updated_at::text = ${c.updated_at_text}
      RETURNING id
    `;
    if (!claimed[0]) {
      unresolved++;
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
        unresolved++;
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
        unresolved++;
        continue;
      }
      failed++;
    } catch (err) {
      unresolved++;
      log.error(
        'Could not verify a stale subscription debit',
        { chargeId: c.id, companyId: c.company_id, reference,
          msg: err instanceof Error ? err.message : String(err) },
        'BillingCron',
      );
    }
  }

  return { settled, failed, unresolved };
}
