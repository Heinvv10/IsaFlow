/**
 * Read-only planning for the subscription-charges cron.
 *
 *   planDueCharges(now)          — one outcome per due subscription: 'create',
 *                                  'skip_zero_amount', 'skip_existing' or
 *                                  'unbilled_no_mandate'. generateDueCharges
 *                                  inserts the 'create' items; the dry run
 *                                  returns the whole plan.
 *
 *   selectChargeableCharges(now) — the charges runQueuedCharges would attempt
 *                                  (queued, or failed and past the backoff).
 *
 * Neither function writes. selectChargeableCharges reads the mandate's card
 * codes, so it runs on the migration_admin pool (S-07e, migration 945).
 */

import { sql } from '@/lib/neon';
import { migrationAdminSqlTx } from '@/lib/auth/migrationAdminPool';
import { MAX_ATTEMPTS } from './subscriptionPeriod';

export const RETRY_BACKOFF_HOURS = 24;

export type ChargePlanOutcome = 'create' | 'skip_zero_amount' | 'skip_existing' | 'unbilled_no_mandate';

export interface PlannedCharge {
  outcome: ChargePlanOutcome;
  companyId: string;
  subscriptionId: string;
  /** Set only for 'create'. */
  mandateId: string | null;
  /** The period the charge is for (YYYY-MM-DD). */
  periodStart: string;
  periodEnd: string;
  amountCents: number;
  /** The subscription's current_period_end, ISO. */
  currentPeriodEnd: string;
  /** Whole days since current_period_end. */
  daysOverdue: number;
}

export async function planDueCharges(now = new Date()): Promise<PlannedCharge[]> {
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
    JOIN companies co ON co.id = s.company_id AND co.status IS DISTINCT FROM 'deleted'
    WHERE s.status IN ('active','past_due')
      AND COALESCE(s.cancel_at_period_end, false) = false
      AND s.current_period_end IS NOT NULL
      AND s.current_period_end <= ${now}
  `;

  const plan: PlannedCharge[] = [];

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

    const item = (outcome: ChargePlanOutcome, mandateId: string | null = null): PlannedCharge => ({
      outcome,
      companyId: sub.company_id,
      subscriptionId: sub.subscription_id,
      mandateId,
      periodStart: nextStart.toISOString().slice(0, 10),
      periodEnd: nextEnd.toISOString().slice(0, 10),
      amountCents,
      currentPeriodEnd: periodEnd.toISOString(),
      daysOverdue: Math.floor((now.getTime() - periodEnd.getTime()) / 86_400_000),
    });

    if (amountCents <= 0) {
      plan.push(item('skip_zero_amount'));
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
      plan.push(item('skip_existing'));
      continue;
    }

    const mandate = await sql<{ id: string }>`
      SELECT id FROM subscription_mandates
      WHERE company_id = ${sub.company_id}
        AND gateway = 'paystack'
        AND status = 'active'
      LIMIT 1
    `;
    plan.push(mandate[0] ? item('create', mandate[0].id) : item('unbilled_no_mandate'));
  }

  return plan;
}

export interface ChargeableCharge {
  id: string;
  company_id: string;
  mandate_id: string;
  amount_cents: string;
  paystack_reference: string | null;
  external_reference: string;
  attempt_count: number;
  status: 'queued' | 'failed';
  paystack_authorization_code: string | null;
  mandate_status: string;
  user_email: string | null;
  period_start: Date | string;
  period_end: Date | string;
}

export async function selectChargeableCharges(now = new Date()): Promise<ChargeableCharge[]> {
  const cutoff = new Date(now.getTime() - RETRY_BACKOFF_HOURS * 3600_000);

  return (await migrationAdminSqlTx('subscription_due_charges', (tx) => tx`
    SELECT c.id, c.company_id, c.mandate_id, c.amount_cents,
           c.paystack_reference, c.external_reference, c.attempt_count, c.status,
           c.period_start, c.period_end,
           m.paystack_authorization_code,
           m.status AS mandate_status,
           u.email AS user_email
    FROM subscription_charges c
    JOIN subscription_mandates m ON m.id = c.mandate_id
    JOIN companies co ON co.id = c.company_id AND co.status IS DISTINCT FROM 'deleted'
    -- Never debit a period the subscription is not owed (cancelled, paused); a
    -- debt for a period already granted stays collectible.
    JOIN subscriptions s ON s.id = c.subscription_id AND s.company_id = c.company_id
      AND (s.status IN ('active','trial','past_due')
           OR c.period_start < (s.current_period_end AT TIME ZONE 'UTC')::date)
    LEFT JOIN users u ON u.id = m.authorised_by::text
    WHERE c.gateway = 'paystack'
      -- Unattributed charges cannot be settled (624's CHECK) and the rejection
      -- would land after the money moved — skip them before Paystack, not after.
      AND c.subscription_id IS NOT NULL
      AND (c.status = 'queued'
           OR (c.status = 'failed' AND c.last_attempt_at < ${cutoff.toISOString()}))
      AND c.attempt_count < ${MAX_ATTEMPTS}
    LIMIT 100
  `)) as ChargeableCharge[];
}
