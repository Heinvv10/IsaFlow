/**
 * The one definition of "how much money is in this GL account".
 *
 * Deliberately identical to the trial balance (`trialBalanceService`): posted
 * entries only, scoped by company on BOTH the entry and the line,
 * SUM(debit) - SUM(credit). Any guard that refuses an action because an account
 * holds money must agree with the report the user is looking at, so this is the
 * only place that definition lives.
 *
 * Two things it is NOT:
 *
 *  - It is not `getAccountBalance` from chartOfAccountsImportService, which
 *    reads the `gl_account_balances` cache. That cache is currently accurate
 *    (measured against a computed aggregate across all four production
 *    companies: absolute drift 0.00 — two triggers keep it so, one on
 *    gl_journal_lines and `trg_gl_je_status_balance` on the draft <-> posted
 *    flip). The reason to bypass it is not distrust of today's numbers: a
 *    correctness guard deciding whether money exists should compute from the
 *    ledger. The cache is an optimisation with two triggers and a
 *    fiscal-period key; this is a safety property, and it should not inherit
 *    the cache's failure modes.
 *
 *  - It does not filter on `is_active`. An account's balance is a fact about
 *    the account, not about whether it is still offered for coding.
 */

import { sql } from '@/lib/neon';

/** Below this, a residual is rounding dust rather than a balance. Matches BALANCE_TOLERANCE. */
export const ACCOUNT_BALANCE_TOLERANCE = 0.005;

/**
 * Net posted balance of one GL account. Positive means debits exceed credits,
 * negative the reverse, whatever the account's normal balance.
 */
export async function getPostedAccountBalance(companyId: string, accountId: string): Promise<number> {
  const rows = (await sql`
    SELECT
      COALESCE(SUM(jl.debit), 0) AS debit_total,
      COALESCE(SUM(jl.credit), 0) AS credit_total
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    WHERE jl.gl_account_id = ${accountId}
      AND jl.company_id = ${companyId}::UUID
      AND je.company_id = ${companyId}::UUID
      AND je.status = 'posted'
  `) as { debit_total: string; credit_total: string }[];

  const debit = Number(rows[0]?.debit_total ?? '0');
  const credit = Number(rows[0]?.credit_total ?? '0');
  return debit - credit;
}

/** True when the account carries more than rounding dust. */
export function holdsMoney(balance: number): boolean {
  return Math.abs(balance) > ACCOUNT_BALANCE_TOLERANCE;
}

/** Rounded to 2dp for display, so the user sees a clean ZAR figure. */
export function formatAccountBalance(balance: number): string {
  return (Math.round(balance * 100) / 100).toFixed(2);
}
