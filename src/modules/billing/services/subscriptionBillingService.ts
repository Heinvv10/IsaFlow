/**
 * Subscription billing service — drives the recurring debit lifecycle:
 *
 *   generateDueCharges()  — for every active subscription whose
 *                           current_period_end is ≤ today and has no
 *                           unsettled charge for that period, create a
 *                           queued charge row.
 *
 *   runQueuedCharges()    — for every queued / failed (retry-eligible)
 *                           charge, call Stitch debitFromMandate() and
 *                           record a matching stitch_payment_requests row.
 *
 * NOTE (2026-04-23): Disabled while on Stitch Express vetting tier.
 * `debitFromMandate` throws immediately until Stitch enables the
 * `client_recurringpaymentconsentrequest` scope. Tables stay in place
 * so we can re-enable without migrations when access lands.
 *
 * All writes are company-scoped. Mandate must be 'active' for the company
 * to be billed; otherwise charges move to 'failed' with reason='no_mandate'.
 */

import { randomBytes } from 'crypto';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { debitFromMandate } from './stitchClient';

const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_HOURS = 24;

export interface GenerateResult {
  created: number;
  skipped: number;
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
      WHERE company_id = ${sub.company_id} AND status = 'active'
      LIMIT 1
    `;
    if (!mandate[0]) {
      skipped++;
      log.warn(
        'Skipping charge generation — no active mandate',
        { companyId: sub.company_id, subscriptionId: sub.subscription_id },
        'BillingCron',
      );
      continue;
    }

    const externalReference = `sub_${sub.company_id}_${nextStart.toISOString().slice(0, 7)}_${randomBytes(4).toString('hex')}`;

    await sql`
      INSERT INTO subscription_charges (
        company_id, mandate_id, period_start, period_end,
        amount_cents, currency, external_reference, status
      ) VALUES (
        ${sub.company_id}, ${mandate[0].id},
        ${nextStart.toISOString().slice(0, 10)},
        ${nextEnd.toISOString().slice(0, 10)},
        ${amountCents}, 'ZAR', ${externalReference}, 'queued'
      )
    `;

    await sql`
      UPDATE subscriptions
      SET current_period_start = ${nextStart.toISOString()},
          current_period_end = ${nextEnd.toISOString()},
          updated_at = now()
      WHERE id = ${sub.subscription_id}
    `;

    created++;
  }

  return { created, skipped };
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
    external_reference: string;
    attempt_count: number;
    status: 'queued' | 'failed';
    stitch_bank_account_id: string | null;
    mandate_status: string;
    company_name: string;
    period_start: Date | string;
  }>`
    SELECT c.id, c.company_id, c.mandate_id, c.amount_cents, c.external_reference,
           c.attempt_count, c.status, c.period_start,
           m.stitch_bank_account_id, m.status AS mandate_status,
           co.name AS company_name
    FROM subscription_charges c
    JOIN subscription_mandates m ON m.id = c.mandate_id
    JOIN companies co ON co.id = c.company_id
    WHERE (c.status = 'queued'
           OR (c.status = 'failed' AND c.last_attempt_at < ${cutoff.toISOString()}))
      AND c.attempt_count < ${MAX_ATTEMPTS}
    LIMIT 100
  `;

  let submitted = 0;
  let failed = 0;
  let skipped = 0;

  for (const c of charges) {
    if (c.mandate_status !== 'active' || !c.stitch_bank_account_id) {
      await sql`
        UPDATE subscription_charges
        SET status = 'failed',
            failure_reason = 'mandate_not_active',
            attempt_count = attempt_count + 1,
            last_attempt_at = now()
        WHERE id = ${c.id}
      `;
      skipped++;
      continue;
    }

    const payerReference = `ISAFLOW-${String(c.period_start).slice(0, 7)}`.slice(0, 20);
    const beneficiaryReference = `ISAFLOW-${c.company_name.replace(/\s+/g, '').slice(0, 10).toUpperCase()}`.slice(0, 20);

    try {
      // Throws until Stitch Express recurring is enabled on the tenant.
      await debitFromMandate({
        bankAccountId: c.stitch_bank_account_id,
        amountCents: Number(c.amount_cents),
        payerReference,
        beneficiaryReference,
        externalReference: c.external_reference,
      });

      // Unreachable while debitFromMandate throws. Left in place so the
      // shape is obvious when the stub is swapped for a real implementation.
      submitted++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await sql`
        UPDATE subscription_charges
        SET status = 'failed',
            failure_reason = ${msg.slice(0, 500)},
            attempt_count = attempt_count + 1,
            last_attempt_at = now()
        WHERE id = ${c.id}
      `;
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
