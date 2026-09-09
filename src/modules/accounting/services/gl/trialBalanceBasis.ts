/**
 * Trial Balance measurement basis
 *
 * A trial balance is a statement of BALANCES, not of one period's movement.
 * The rules every trial-balance producer in this repo must share:
 *
 *   - Balance-sheet accounts (asset / liability / equity) carry forward, so
 *     their balance is cumulative from inception to the end of the reporting
 *     range.
 *   - Income-statement accounts (revenue / expense) restart each fiscal year,
 *     so their balance is the movement within the reporting range only.
 *   - The ledger holds no year-end closing journals (see balanceSheetService's
 *     `calculateRetainedEarnings`), so the profit earned BEFORE the range still
 *     sits in the revenue/expense accounts. Excluding it without putting it
 *     back into equity would leave the trial balance out of balance by exactly
 *     that amount. `getRetainedEarningsBroughtForward` computes it, and
 *     `broughtForwardLine` gives it a row that says on its face that it is
 *     derived rather than posted.
 *
 * Dates are handled as 'YYYY-MM-DD' strings throughout — never via Date
 * arithmetic and never via `.toISOString()`. See src/lib/pgTypes.ts.
 *
 * "When does this company's fiscal year start" is NOT here: it is general
 * purpose and lives in fiscalYearBasis.ts, so a payroll or CIPC caller can
 * import it without importing something called "trialBalanceBasis".
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';

/** Account types whose balances accumulate across fiscal years. */
export const BALANCE_SHEET_TYPES = ['asset', 'liability', 'equity'] as const;

/** Account types whose balances reset at the start of each fiscal year. */
export const INCOME_STATEMENT_TYPES = ['revenue', 'expense'] as const;

/**
 * Accumulated profit earned strictly BEFORE `fromDate`, expressed as a credit
 * (positive = accumulated profit, negative = accumulated loss).
 *
 * Revenue is credit-normal and expense debit-normal, so `credit - debit`
 * summed across both types is income less expenses in a single pass.
 */
export async function getRetainedEarningsBroughtForward(
  companyId: string,
  fromDate: string,
  costCentreId?: string,
): Promise<number> {
  const ccId = costCentreId ?? null;
  const rows = (await sql`
    SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS retained
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
    WHERE je.status = 'posted'
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND je.entry_date < ${fromDate}
      AND ga.account_type IN ('revenue', 'expense')
      AND (${ccId}::TEXT IS NULL OR jl.cost_center_id = ${ccId}::UUID
        OR jl.cc1_id = ${ccId}::UUID OR jl.cc2_id = ${ccId}::UUID)
  `) as DbRow[];
  return round2(Number(rows[0]?.retained ?? 0));
}

/**
 * Account code for the derived brought-forward line.
 *
 * Deliberately NOT the company's real retained-earnings account. Folding the
 * figure into the posted equity row would show an auditor a balance on a
 * ledger account that no journal supports, with nothing on screen to say so —
 * and every production company hits this path, because none of them carries a
 * posted equity balance. Keeping it on its own row means the posted accounts
 * still tie to the ledger line for line, and the one computed number is
 * visibly computed.
 */
export const BROUGHT_FORWARD_CODE = 'RE-BF';

export interface BroughtForwardLine {
  accountCode: string;
  accountName: string;
}

/** The derived line's identity, naming the cut-off date it was computed from. */
export function broughtForwardLine(fromDate: string): BroughtForwardLine {
  return {
    accountCode: BROUGHT_FORWARD_CODE,
    // No comma: this string is a CSV field in the CaseWare export, and third
    // party audit importers vary in how well they honour quoting.
    accountName: `Retained Earnings b/f (derived — not posted; profit before ${fromDate})`,
  };
}

/**
 * Round to cents, killing the float noise that SUM() of NUMERIC → Number leaves
 * behind.
 *
 * Normalises negative zero. A balanced ledger whose raw difference is a tiny
 * negative drift rounds to -0, which `Object.is` distinguishes from 0 and which
 * formats as "-R0.00" in the UI and the CSV export — a trial balance reporting
 * a negative nothing.
 */
export function round2(n: number): number {
  const rounded = Math.round((n + Number.EPSILON) * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

/**
 * Split a net balance into the debit and credit columns of a trial balance.
 * A trial balance reports each account once, on its balance side — not the
 * gross debit and credit turnover that produced it.
 */
export function splitNet(net: number): { debit: number; credit: number } {
  const rounded = round2(net);
  return rounded >= 0 ? { debit: rounded, credit: 0 } : { debit: 0, credit: -rounded };
}
