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

const TURNOVER_THRESHOLD_CENTS = 100_000_000; // R1 000 000

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
  const paygEligible = turnover !== null && turnover < TURNOVER_THRESHOLD_CENTS;

  // Bureaus don't declare their own turnover, so they don't get auto-PAYG.
  // Starter suggestion only applies when turnover is declared and >= R1M.
  const suggestedPlanCode: CompanySeed['suggestedPlanCode'] =
    signup.signup_type === 'accountant' ? null
      : paygEligible                      ? 'payg'
      : turnover !== null                 ? 'starter'
      : null;

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
