/**
 * PAYG eligibility service.
 *
 * A company qualifies for the Pay-As-You-Go plan when ANY one of:
 *   - `volume`  — avg < 200 posted journal entries/month over rolling 3 months
 *   - `turnover` — declared `companies.annual_turnover_cents` < R1 000 000 (< 100 000 000 cents)
 *   - `admin`    — `companies.payg_eligible = true` (manual override from admin platform)
 *
 * Spec: docs/superpowers/specs/2026-04-19-payg-flows-pricing-design.md §3
 */

import { sql } from '@/lib/neon';

export type EligibilityReason = 'volume' | 'turnover' | 'admin' | 'ineligible';

export interface EligibilityResult {
  eligible: boolean;
  reason: EligibilityReason;
  /** Signals used — caller may display these to support the decision. */
  signals: {
    monthlyTransactions: number | null;
    annualTurnoverCents: number | null;
    adminFlagged: boolean;
  };
}

const TURNOVER_THRESHOLD_CENTS = 100_000_000; // R1 000 000
const MONTHLY_TX_THRESHOLD = 200;

export async function isEligible(companyId: string): Promise<EligibilityResult> {
  const [companyRow] = (await sql`
    SELECT payg_eligible, annual_turnover_cents
      FROM companies
     WHERE id = ${companyId}
     LIMIT 1
  `) as Array<{ payg_eligible: boolean; annual_turnover_cents: number | null }>;

  if (!companyRow) {
    return {
      eligible: false,
      reason: 'ineligible',
      signals: { monthlyTransactions: null, annualTurnoverCents: null, adminFlagged: false },
    };
  }

  const adminFlagged = companyRow.payg_eligible === true;
  const annualTurnoverCents = companyRow.annual_turnover_cents ?? null;

  // Rolling 3-month POSTED journal entries → monthly average.
  const [volumeRow] = (await sql`
    SELECT COUNT(*)::int AS total
      FROM gl_journal_entries
     WHERE company_id = ${companyId}
       AND status = 'posted'
       AND entry_date > (CURRENT_DATE - INTERVAL '3 months')
  `) as Array<{ total: number }>;

  const monthlyTransactions = Math.round((volumeRow?.total ?? 0) / 3);

  const signals = { monthlyTransactions, annualTurnoverCents, adminFlagged };

  if (adminFlagged) {
    return { eligible: true, reason: 'admin', signals };
  }
  if (annualTurnoverCents !== null && annualTurnoverCents < TURNOVER_THRESHOLD_CENTS) {
    return { eligible: true, reason: 'turnover', signals };
  }
  if (monthlyTransactions < MONTHLY_TX_THRESHOLD) {
    return { eligible: true, reason: 'volume', signals };
  }

  return { eligible: false, reason: 'ineligible', signals };
}
