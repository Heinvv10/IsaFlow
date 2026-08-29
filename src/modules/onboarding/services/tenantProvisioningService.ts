/**
 * Tenant provisioning — the single path that turns a person into a tenant.
 *
 * Both entry points converge here so plan/PAYG policy can't drift:
 *   - self-serve signup    (pages/api/auth/register.ts)
 *   - admin waitlist promote (waitlistPromotionService)
 *
 * Policy (spec: docs/superpowers/specs/2026-04-19-payg-flows-pricing-design.md §3,
 * plan decided 2026-08-19 in docs/plans/2026-08-19-self-serve-signup.md):
 *   - New tenants start on the `trial` plan for TRIAL_DAYS days.
 *   - `payg_eligible` is true when declared turnover < R1 000 000.
 *   - Undeclared turnover stays NULL — never defaulted to zero, because zero
 *     would read as "declared micro-enterprise" and wrongly grant PAYG.
 *
 * Plan lives on `subscriptions`, NOT `companies.plan_id` — that column is
 * vestigial (0 of 10 prod rows populated as at 2026-08-19) and nothing reads it.
 */

import { log } from '@/lib/logger';

/** R1 000 000 in cents. Below this, a declared turnover qualifies for PAYG. */
export const TURNOVER_THRESHOLD_CENTS = 100_000_000;

/** Length of the free trial granted to every new tenant. */
export const TRIAL_DAYS = 14;

export type SignupType = 'direct' | 'accountant';

/**
 * PAYG eligibility from declared annual turnover.
 * NULL (undeclared) is NOT eligible — we don't grant PAYG on an absent claim.
 */
export function isPaygEligible(annualTurnoverCents: number | null): boolean {
  return annualTurnoverCents !== null && annualTurnoverCents < TURNOVER_THRESHOLD_CENTS;
}

/**
 * Plan a tenant should convert to when the trial ends. Bureaus don't declare
 * their own turnover, so they never auto-qualify for PAYG.
 * Returns null when we can't infer one — the admin picks at conversion time.
 */
export function suggestedPlanCode(
  annualTurnoverCents: number | null,
  signupType: SignupType,
): 'payg' | 'starter' | null {
  if (signupType === 'accountant') return null;
  if (isPaygEligible(annualTurnoverCents)) return 'payg';
  return annualTurnoverCents !== null ? 'starter' : null;
}

/** Trial expiry for a tenant created at `from`. */
export function trialEndsAt(from: Date): Date {
  return new Date(from.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Minimal shape of a `pg` client. Declared structurally so callers can pass a
 * pooled client inside their own transaction and tests can pass a fake.
 */
export interface QueryRunner {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
}

export interface ProvisionTenantInput {
  /** GoTrue user id of the person who will own the company. */
  ownerUserId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string;
  phone: string | null;
  /** NULL when undeclared. Never pass 0 to mean "unknown". */
  annualTurnoverCents: number | null;
  signupType: SignupType;
}

export interface ProvisionTenantResult {
  companyId: string;
  paygEligible: boolean;
  trialEndsAt: Date;
  /** null when the `trial` plan row is missing — company is still created. */
  subscriptionId: string | null;
  suggestedPlanCode: 'payg' | 'starter' | null;
}

/**
 * Create the company, its trial subscription, the owner membership and the
 * user profile shadow.
 *
 * MUST be called inside a transaction the caller owns — this function does not
 * BEGIN or COMMIT, so a failure anywhere rolls the whole tenant back with it.
 * The client must have BYPASSRLS (the admin pool): the RLS policy on
 * `company_users` refuses the INSERT because the user has no pre-existing
 * membership to satisfy USING.
 */
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

export async function provisionTenant(
  client: QueryRunner,
  input: ProvisionTenantInput,
  now: Date = new Date(),
): Promise<ProvisionTenantResult> {
  const paygEligible = isPaygEligible(input.annualTurnoverCents);
  const trialEnd = trialEndsAt(now);

  const company = await client.query<{ id: string }>(
    `INSERT INTO companies
       (name, email, phone, is_active, annual_turnover_cents, payg_eligible, trial_ends_at)
     VALUES ($1, $2, $3, true, $4, $5, $6)
     RETURNING id`,
    [
      input.companyName,
      input.email,
      input.phone,
      input.annualTurnoverCents,
      paygEligible,
      trialEnd,
    ],
  );
  const companyId = company.rows[0]!.id;

  // Trial subscription. Plan lookup is by code so a re-seeded plans table
  // can't silently point new tenants at the wrong row.
  const plan = await client.query<{ id: string }>(
    `SELECT id FROM plans WHERE code = 'trial' LIMIT 1`,
  );
  let subscriptionId: string | null = null;
  if (plan.rows.length === 0) {
    // Don't fail the signup over a missing catalogue row — the tenant is still
    // usable and an admin can attach a plan. But this is a misconfiguration.
    log.error(
      'trial plan row missing — tenant created without a subscription',
      { companyId },
      'onboarding',
    );
  } else {
    const sub = await client.query<{ id: string }>(
      `INSERT INTO subscriptions
         (company_id, plan_id, status, billing_cycle,
          current_period_start, current_period_end)
       VALUES ($1::uuid, $2::uuid, 'trial', 'monthly', $3, $4)
       RETURNING id`,
      [companyId, plan.rows[0]!.id, now, trialEnd],
    );
    subscriptionId = sub.rows[0]!.id;
  }

  await client.query(
    `INSERT INTO company_users (company_id, user_id, role, is_default)
     VALUES ($1::uuid, $2, 'owner', true)`,
    [companyId, input.ownerUserId],
  );

  await client.query(
    `INSERT INTO users (id, email, first_name, last_name, is_active, role)
     VALUES ($1, $2, $3, $4, true, 'admin')
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
    [input.ownerUserId, input.email, input.firstName, input.lastName],
  );

  // Fiscal periods for the CURRENT year. Until this existed a new tenant had
  // none at all, so every journal date fell outside every period and posted with
  // fiscal_period_id NULL — invisible to the trial balance, the VAT201 and the
  // AFS, because postJournalEntry's closed-period check is guarded by
  // `if (entry.fiscalPeriodId)` and skips a NULL entirely.
  //
  // Inserted here on the provisioning client rather than by calling
  // createFiscalYear: that function uses the `sql` tagged template, and this
  // runs on the admin (BYPASSRLS) client inside the provisioning transaction —
  // the RLS policies would otherwise refuse the write for a company the caller
  // is not yet a member of.
  //
  // ON CONFLICT DO NOTHING so re-provisioning is harmless; the unique index is
  // (company_id, fiscal_year, period_number). Later years are created on demand
  // by ensureFiscalPeriodForDate.
  const year = now.getFullYear();
  for (let periodNumber = 1; periodNumber <= 12; periodNumber++) {
    const lastDay = new Date(year, periodNumber, 0).getDate();
    const mm = String(periodNumber).padStart(2, '0');
    await client.query(
      `INSERT INTO fiscal_periods
         (company_id, period_name, period_number, fiscal_year, start_date, end_date, status)
       VALUES ($1::uuid, $2, $3, $4, $5::date, $6::date, 'open')
       ON CONFLICT DO NOTHING`,
      [
        companyId,
        `${MONTH_NAMES[periodNumber - 1]} ${year}`,
        periodNumber,
        year,
        `${year}-${mm}-01`,
        `${year}-${mm}-${String(lastDay).padStart(2, '0')}`,
      ],
    );
  }

  return {
    companyId,
    paygEligible,
    trialEndsAt: trialEnd,
    subscriptionId,
    suggestedPlanCode: suggestedPlanCode(input.annualTurnoverCents, input.signupType),
  };
}
