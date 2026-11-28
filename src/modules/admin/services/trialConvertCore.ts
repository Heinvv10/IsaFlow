/**
 * Converting a trial company to a paying one: the ONE code path shared by the
 * admin "Convert to Paid" (trialService.markAsConverted, platform_admin) and a
 * tenant owner's self-serve upgrade (billing/services/selfServeUpgrade.ts,
 * migration_admin). It runs on the transaction it is given and neither BEGINs
 * nor COMMITs; the caller audits the action.
 *
 *  - the company row is locked, so two converts of the same company queue;
 *  - the company must be on a trial or active: a suspended or cancelled one is
 *    refused (409), never silently reinstated, and no suspension column is touched;
 *  - the plan must exist, be active and not be an internal plan (trial, payg);
 *  - a company that already pays (active/past_due on a real plan) is refused,
 *    never silently re-planned without proration; a company with any paused
 *    subscription is refused too (resume or cancel it first);
 *  - the newest live trial/free-plan subscription is UPDATED to the new plan and
 *    every other live trial row of the company is cancelled, so one live
 *    subscription remains; with none, one is inserted. There is no unique index
 *    on subscriptions.company_id, so this is update-then-insert under the
 *    company lock, not ON CONFLICT;
 *  - the subscription gets a monthly period starting now, so the billing run
 *    (which skips a NULL current_period_end) bills it a month from now, as
 *    createSubscription does for an admin-made one, and only if the company has
 *    an active Paystack mandate (reported back).
 *
 * Options (all off for the admin path, which behaves as it always has):
 *  - requireTrial: refuse (`not_on_trial`) a company that never had a trial;
 *  - requireActiveMandate: refuse (`mandate_required`), before any write, unless
 *    an active Paystack mandate with an authorization code is on file, so the
 *    charge run can bill it, and refuse (`mandate_plan_mismatch`) unless every
 *    active Paystack mandate's max_amount_cents equals the plan's monthly price.
 *    The self-serve start sets that ceiling to the price of the plan the owner
 *    authorised, so a different plan (dearer or cheaper) needs a new authorisation;
 *  - samePlanIsNoop: a company already paying on THIS plan answers
 *    `alreadyConverted: true` and nothing is written (an idempotent retry); a
 *    different plan is still `already_paid`.
 */

import type { DbRow, TxSql } from '@/lib/neon';
import { isConvertiblePlanCode } from '../types/trialPlans';
import { TrialConvertError } from './trialErrors';

export interface ConvertResult {
  subscriptionId: string;
  /** When billing first looks at the subscription: the end of its first period. */
  firstChargeAt: string;
  /** Charging needs an active Paystack mandate; without one the company is not billed. */
  hasActiveMandate: boolean;
  /** True only under samePlanIsNoop, when the company already paid on this plan and nothing was written. */
  alreadyConverted: boolean;
}

export interface ConvertOptions {
  requireTrial?: boolean;
  requireActiveMandate?: boolean;
  samePlanIsNoop?: boolean;
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return value as string;
}

async function hasActivePaystackMandate(tx: TxSql, companyId: string): Promise<boolean> {
  const rows = await tx`
    SELECT 1 FROM subscription_mandates
    WHERE company_id = ${companyId}::uuid AND gateway = 'paystack' AND status = 'active'
    LIMIT 1
  `;
  return rows.length > 0;
}

export async function convertTrialInTx(
  tx: TxSql, companyId: string, planId: string, opts: ConvertOptions = {},
): Promise<ConvertResult> {
  const company = (await tx`
    SELECT COALESCE(status, 'active') AS status, (trial_ends_at IS NOT NULL) AS had_trial FROM companies
    WHERE id = ${companyId}::uuid AND status IS DISTINCT FROM 'deleted'
    FOR UPDATE
  `)[0] as DbRow | undefined;
  if (!company) throw new TrialConvertError('company_not_found', 'Company not found');
  if (company.status !== 'trial' && company.status !== 'active') {
    throw new TrialConvertError('company_not_convertible', `Company status "${String(company.status)}" cannot be converted`);
  }
  if (opts.requireTrial && company.had_trial !== true) {
    throw new TrialConvertError('not_on_trial', 'This company is not on a trial');
  }

  const plan = (await tx`SELECT code, is_active, monthly_price_cents FROM plans WHERE id = ${planId}::uuid`)[0] as DbRow | undefined;
  if (!plan) throw new TrialConvertError('plan_not_found', 'Plan not found');
  if (plan.is_active !== true || !isConvertiblePlanCode(plan.code as string)) {
    throw new TrialConvertError('plan_not_convertible', 'This plan cannot be used to convert a trial');
  }

  const current = (await tx`
    SELECT s.id, s.status, s.plan_id, s.current_period_end,
           (s.status IN ('active', 'past_due') AND p.code <> 'trial') AS is_paid
    FROM subscriptions s
    JOIN plans p ON p.id = s.plan_id
    WHERE s.company_id = ${companyId}::uuid AND s.status IN ('trial', 'active', 'past_due', 'paused')
    ORDER BY (s.status IN ('active', 'past_due') AND p.code <> 'trial') DESC, s.created_at DESC
    LIMIT 1
  `)[0] as DbRow | undefined;
  if (current?.is_paid === true) {
    if (opts.samePlanIsNoop && String(current.plan_id) === planId) {
      return {
        subscriptionId: current.id as string,
        firstChargeAt: toIso(current.current_period_end),
        hasActiveMandate: await hasActivePaystackMandate(tx, companyId),
        alreadyConverted: true,
      };
    }
    throw new TrialConvertError('already_paid', 'This company is already on a paid plan');
  }
  // ANY paused subscription, not only the newest row: converting beside one would leave it behind.
  const paused = await tx`
    SELECT 1 FROM subscriptions WHERE company_id = ${companyId}::uuid AND status = 'paused' LIMIT 1
  `;
  if (paused.length > 0) {
    throw new TrialConvertError('subscription_paused', 'Resume or cancel the paused subscription first');
  }

  if (opts.requireActiveMandate) {
    // The charge run (runQueuedCharges) bills with the authorization code, so a row without one cannot be charged.
    const active = (await tx`
      SELECT max_amount_cents, (paystack_authorization_code IS NOT NULL) AS chargeable
      FROM subscription_mandates
      WHERE company_id = ${companyId}::uuid AND gateway = 'paystack' AND status = 'active'
    `) as DbRow[];
    if (!active.some((m) => m.chargeable === true)) {
      throw new TrialConvertError('mandate_required', 'Authorise a payment method before upgrading');
    }
    // The owner authorised one plan's price; any other plan is a new authorisation.
    const priceCents = Number(plan.monthly_price_cents);
    if (active.some((m) => Number(m.max_amount_cents) !== priceCents)) {
      throw new TrialConvertError('mandate_plan_mismatch', 'The payment method was authorised for a different plan');
    }
  }

  await tx`
    UPDATE companies
    SET status = 'active', plan_id = ${planId}::uuid, updated_at = NOW()
    WHERE id = ${companyId}::uuid
  `;

  let written: unknown[];
  if (current) {
    written = await tx`
      UPDATE subscriptions
      SET plan_id = ${planId}::uuid, status = 'active', billing_cycle = 'monthly',
          current_period_start = NOW(), current_period_end = NOW() + INTERVAL '1 month',
          cancel_at_period_end = false, updated_at = NOW()
      WHERE id = ${current.id as string}::uuid AND company_id = ${companyId}::uuid
      RETURNING id, current_period_end
    `;
    // Any other live trial row (a stray second trial, or "active" on the free plan) would
    // double-count and could be billed: end it.
    await tx`
      UPDATE subscriptions
      SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
      WHERE company_id = ${companyId}::uuid
        AND id <> ${current.id as string}::uuid
        AND status IN ('trial', 'active', 'past_due', 'paused')
        AND (status = 'trial' OR plan_id IN (SELECT id FROM plans WHERE code = 'trial'))
    `;
  } else {
    written = await tx`
      INSERT INTO subscriptions (
        company_id, plan_id, status, billing_cycle,
        current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at
      ) VALUES (
        ${companyId}::uuid, ${planId}::uuid, 'active', 'monthly',
        NOW(), NOW() + INTERVAL '1 month', false, NOW(), NOW()
      )
      RETURNING id, current_period_end
    `;
  }

  const row = written[0] as DbRow;
  return {
    subscriptionId: row.id as string,
    firstChargeAt: toIso(row.current_period_end),
    hasActiveMandate: await hasActivePaystackMandate(tx, companyId),
    alreadyConverted: false,
  };
}
