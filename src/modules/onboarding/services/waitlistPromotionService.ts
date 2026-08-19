/**
 * Waitlist → Company promotion service.
 *
 * When a pre-launch waitlist lead is approved and we're ready to onboard
 * them as a real tenant, this service computes the seed payload for the
 * companies INSERT — including the PAYG-flavour fields from spec §3:
 *
 *   - annual_turnover_cents — copied through from the declared value
 *   - payg_eligible         — true when declared turnover < R1 000 000
 *
 * The actual INSERT happens in whichever admin flow creates the company
 * (admin platform console, post-launch self-serve signup, etc.); this
 * service produces the column map so every path converges on one policy.
 *
 * Spec: docs/superpowers/specs/2026-04-19-payg-flows-pricing-design.md §3
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createCompany } from '@/modules/admin/services/adminCompanyService';
import {
  isPaygEligible,
  suggestedPlanCode as policySuggestedPlanCode,
} from './tenantProvisioningService';

export interface WaitlistSignupRow {
  id: string;
  name: string | null;
  email: string;
  signup_type: 'direct' | 'accountant';
  company_name: string | null;
  practice_name: string | null;
  phone: string | null;
  annual_turnover_cents: number | null;
}

export interface CompanySeed {
  /** Suggested company name — falls back to practice_name / email-localpart. */
  name: string;
  /** Lead's contact email, for the admin audit trail. */
  contactEmail: string;
  /** Null when undeclared — do not default to zero. */
  annualTurnoverCents: number | null;
  /** True when declared turnover < R1M (micro-enterprise PAYG eligibility). */
  paygEligible: boolean;
  /** Hint for which onboarding flow to route into. */
  suggestedPlanCode: 'payg' | 'starter' | null;
}

export async function loadWaitlistSignup(id: string): Promise<WaitlistSignupRow | null> {
  const rows = (await sql`
    SELECT id, name, email, signup_type, company_name, practice_name,
           phone, annual_turnover_cents
      FROM waitlist_signups
     WHERE id = ${id}
     LIMIT 1
  `) as WaitlistSignupRow[];
  return rows[0] ?? null;
}

/**
 * Build the company seed payload from a waitlist lead. Pure — no DB writes,
 * no side effects; call from whichever promotion code path creates the
 * company so all paths use the same PAYG-eligibility policy.
 */
export function buildCompanySeed(signup: WaitlistSignupRow): CompanySeed {
  const turnover = signup.annual_turnover_cents;
  // Policy is shared with self-serve signup — see tenantProvisioningService.
  const paygEligible = isPaygEligible(turnover);
  const suggestedPlanCode: CompanySeed['suggestedPlanCode'] =
    policySuggestedPlanCode(turnover, signup.signup_type);

  const nameFallback = signup.email.split('@')[0] ?? 'company';
  const name = signup.signup_type === 'accountant'
    ? (signup.practice_name ?? nameFallback)
    : (signup.company_name ?? nameFallback);

  return {
    name,
    contactEmail: signup.email,
    annualTurnoverCents: turnover,
    paygEligible,
    suggestedPlanCode,
  };
}

/**
 * Convenience: load + build in one call. Returns null if the waitlist row is
 * missing (e.g. already promoted and cleaned up).
 */
export async function resolveCompanySeedForWaitlistId(
  waitlistId: string,
): Promise<CompanySeed | null> {
  const signup = await loadWaitlistSignup(waitlistId);
  if (!signup) {
    log.warn('waitlist promotion: signup not found', { waitlistId }, 'onboarding');
    return null;
  }
  return buildCompanySeed(signup);
}

export interface WaitlistListRow extends WaitlistSignupRow {
  created_at: string;
  promoted_at: string | null;
  promoted_company_id: string | null;
}

export interface WaitlistListResult {
  items: WaitlistListRow[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return value as string;
}

/**
 * Admin listing of waitlist signups.
 * status='pending' → not yet promoted; 'promoted' → already onboarded; 'all' → both.
 */
export async function listWaitlistSignups(filters: {
  status?: 'pending' | 'promoted' | 'all';
  search?: string;
  page?: number;
  limit?: number;
} = {}): Promise<WaitlistListResult> {
  const page = Math.max(1, filters.page ?? 1);
  const limit = Math.min(100, Math.max(1, filters.limit ?? 25));
  const offset = (page - 1) * limit;
  const status = filters.status ?? 'pending';
  const search = filters.search?.trim() ? `%${filters.search.trim()}%` : null;

  const pendingOnly  = status === 'pending';
  const promotedOnly = status === 'promoted';

  const [countRow] = await sql`
    SELECT COUNT(*)::int AS total
      FROM waitlist_signups
     WHERE (${search}::text IS NULL
            OR email ILIKE ${search}
            OR COALESCE(name,'') ILIKE ${search}
            OR COALESCE(company_name,'') ILIKE ${search}
            OR COALESCE(practice_name,'') ILIKE ${search})
       AND (${pendingOnly}::boolean  = false OR promoted_at IS NULL)
       AND (${promotedOnly}::boolean = false OR promoted_at IS NOT NULL)
  `;

  const rows = await sql`
    SELECT id, name, email, signup_type, company_name, practice_name,
           phone, annual_turnover_cents, created_at, promoted_at, promoted_company_id
      FROM waitlist_signups
     WHERE (${search}::text IS NULL
            OR email ILIKE ${search}
            OR COALESCE(name,'') ILIKE ${search}
            OR COALESCE(company_name,'') ILIKE ${search}
            OR COALESCE(practice_name,'') ILIKE ${search})
       AND (${pendingOnly}::boolean  = false OR promoted_at IS NULL)
       AND (${promotedOnly}::boolean = false OR promoted_at IS NOT NULL)
     ORDER BY created_at DESC
     LIMIT ${limit} OFFSET ${offset}
  `;

  const total = Number((countRow as { total: number }).total ?? 0);

  return {
    items: (rows as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      name: r.name as string | null,
      email: r.email as string,
      signup_type: r.signup_type as 'direct' | 'accountant',
      company_name: r.company_name as string | null,
      practice_name: r.practice_name as string | null,
      phone: r.phone as string | null,
      annual_turnover_cents:
        r.annual_turnover_cents == null ? null : Number(r.annual_turnover_cents),
      created_at: toIso(r.created_at) ?? '',
      promoted_at: toIso(r.promoted_at),
      promoted_company_id: (r.promoted_company_id as string | null) ?? null,
    })),
    total,
    page,
    limit,
    total_pages: Math.ceil(total / limit) || 1,
  };
}

export interface PromoteOptions {
  /** Override the plan suggestion from the seed; must be a valid plans.code. */
  planCodeOverride?: string | null;
}

export interface PromotionResult {
  status: 'promoted' | 'already_promoted' | 'not_found';
  companyId: string | null;
  seed: CompanySeed | null;
  planCode: string | null;
}

async function resolvePlanIdByCode(code: string): Promise<string | null> {
  const rows = (await sql`
    SELECT id FROM plans WHERE code = ${code} LIMIT 1
  `) as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

/**
 * Promote a waitlist signup into a real company row.
 *
 *   - Idempotent: if the row is already promoted, returns the existing mapping.
 *   - Missing row: returns `{ status: 'not_found' }`.
 *   - Success: creates the company (with PAYG flags from the seed), stamps the
 *     signup as promoted, and returns the new company id.
 *
 * Plan resolution order: `planCodeOverride` → seed.suggestedPlanCode → no plan.
 * Unknown plan codes are logged and treated as "no plan" rather than throwing,
 * so a missing seed plan never blocks promotion.
 */
export async function promoteWaitlistSignup(
  waitlistId: string,
  opts: PromoteOptions = {},
): Promise<PromotionResult> {
  const signup = await loadWaitlistSignup(waitlistId);
  if (!signup) {
    return { status: 'not_found', companyId: null, seed: null, planCode: null };
  }

  const existing = (await sql`
    SELECT promoted_company_id FROM waitlist_signups
     WHERE id = ${waitlistId} AND promoted_at IS NOT NULL
     LIMIT 1
  `) as Array<{ promoted_company_id: string | null }>;
  if (existing.length > 0) {
    return {
      status: 'already_promoted',
      companyId: existing[0]?.promoted_company_id ?? null,
      seed: buildCompanySeed(signup),
      planCode: null,
    };
  }

  const seed = buildCompanySeed(signup);
  const planCode = opts.planCodeOverride ?? seed.suggestedPlanCode;
  let planId: string | null = null;
  if (planCode) {
    planId = await resolvePlanIdByCode(planCode);
    if (!planId) {
      log.warn('waitlist promotion: unknown plan code, proceeding without plan', {
        waitlistId,
        planCode,
      }, 'onboarding');
    }
  }

  const created = await createCompany({
    name:                  seed.name,
    email:                 seed.contactEmail,
    phone:                 signup.phone,
    plan_id:               planId,
    annual_turnover_cents: seed.annualTurnoverCents,
    payg_eligible:         seed.paygEligible,
  });

  // The app reads a company's plan from `subscriptions`, not the vestigial
  // `companies.plan_id` that createCompany writes — so without this row the
  // promoted tenant has no effective plan at all.
  if (planId) {
    await sql`
      INSERT INTO subscriptions
        (company_id, plan_id, status, billing_cycle, current_period_start)
      VALUES (${created.id}::uuid, ${planId}::uuid, 'active', 'monthly', NOW())
    `;
  }

  await sql`
    UPDATE waitlist_signups
       SET promoted_at         = NOW(),
           promoted_company_id = ${created.id}::uuid
     WHERE id = ${waitlistId}
  `;

  log.info('waitlist promoted', {
    waitlistId,
    companyId: created.id,
    planCode,
    paygEligible: seed.paygEligible,
  }, 'onboarding');

  return { status: 'promoted', companyId: created.id, seed, planCode: planCode ?? null };
}
