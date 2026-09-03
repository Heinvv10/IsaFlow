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
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';

/** Account types whose balances accumulate across fiscal years. */
export const BALANCE_SHEET_TYPES = ['asset', 'liability', 'equity'] as const;

/** Account types whose balances reset at the start of each fiscal year. */
export const INCOME_STATEMENT_TYPES = ['revenue', 'expense'] as const;

/** Default South African fiscal year start (March) when a company has none set. */
export const DEFAULT_FY_START_MONTH = 3;

/**
 * First day of the fiscal year containing `date`.
 *
 * `fyStartMonth` is `companies.financial_year_start` (1 = January). Every
 * production company is 3, i.e. 1 March – 28/29 February — do NOT assume a
 * calendar year. Note that `fiscal_periods.fiscal_year` is calendar-based and
 * is therefore useless for this: February 2026 is stored as fiscal_year 2026
 * but belongs to the March-2025 fiscal year.
 *
 * @param date  'YYYY-MM-DD'. Parsed by string split, never by `new Date()`.
 */
export function fiscalYearStart(date: string, fyStartMonth: number): string {
  const [yearPart, monthPart] = date.slice(0, 10).split('-');
  const year = Number(yearPart);
  const month = Number(monthPart);
  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    throw new Error(`fiscalYearStart: unparseable date '${date}'`);
  }
  const startMonth = Number.isFinite(fyStartMonth) && fyStartMonth >= 1 && fyStartMonth <= 12
    ? Math.trunc(fyStartMonth)
    : DEFAULT_FY_START_MONTH;
  const fyYear = month >= startMonth ? year : year - 1;
  return `${String(fyYear).padStart(4, '0')}-${String(startMonth).padStart(2, '0')}-01`;
}

/** `companies.financial_year_start`, defaulting to March. */
export async function getFiscalYearStartMonth(companyId: string): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(financial_year_start, ${DEFAULT_FY_START_MONTH}) AS fy_start_month
    FROM companies WHERE id = ${companyId}::UUID LIMIT 1
  `) as DbRow[];
  const raw = Number(rows[0]?.fy_start_month);
  return Number.isFinite(raw) && raw >= 1 && raw <= 12 ? raw : DEFAULT_FY_START_MONTH;
}

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
      AND (${ccId}::TEXT IS NULL OR jl.cost_center_id = ${ccId}::UUID)
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

/** Round to cents, killing the float noise that SUM() of NUMERIC → Number leaves behind. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
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
