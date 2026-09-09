/**
 * Trial Balance Service
 * GL trial balance queries — split from journalEntryCrudService.ts.
 *
 * Returns `TrialBalanceRow[]` — a flat array.
 * The API handler wraps it as `{ rows: TrialBalanceRow[], totalDebit, totalCredit }`.
 * The canonical container key is `rows` (not `accounts`).
 *
 * CS-01: this used to filter `je.fiscal_period_id = <period>` and report the
 * resulting gross debit and credit turnover as `debit_balance` / `credit_balance`.
 * That is one month's MOVEMENT, not a balance: Brightsphere's bank account showed
 * R113,843 of February activity against an actual balance of R6,003,472.64, and
 * the `HAVING` clause dropped every account that happened not to move that month
 * however large the balance it carried. See trialBalanceBasis.ts for the rules
 * this now follows.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import type { TrialBalanceRow, TrialBalanceReport } from '../../types/gl.types';
import {
  DEFAULT_FY_START_MONTH,
  fiscalYearStart,
  resolveFiscalYearStartMonth,
} from './fiscalYearBasis';
import {
  broughtForwardLine,
  getRetainedEarningsBroughtForward,
  round2,
  splitNet,
} from './trialBalanceBasis';

type Row = DbRow;

export interface TrialBalanceOptions {
  costCentreId?: string;
  /**
   * Keep accounts that have posted lines in range but whose balance AND movement
   * both net to zero. Off by default — those accounts say nothing on a trial
   * balance. Note this is NOT what the old `HAVING` clause did: that dropped
   * accounts with no movement THIS PERIOD however large the balance they carried,
   * conflating "dormant" with "nothing to show". Such accounts are always
   * returned now, with `periodDebit`/`periodCredit` at zero to say so.
   */
  includeZeroBalances?: boolean;
}

/**
 * Half a cent — the single tolerance for the balanced assertion. Never inline
 * another. Applied to the UNROUNDED difference: `===` on two floats called a
 * 1e-10 drift an out-of-balance ledger, and a 0.02 slop elsewhere would have
 * called a real one-cent break balanced.
 */
export const BALANCE_TOLERANCE = 0.005;

interface PeriodBasis {
  periodStart: string;
  periodEnd: string;
  /** First day of the fiscal year the period falls in — the income-statement cut-off. */
  fyStart: string;
}

async function loadPeriodBasis(companyId: string, fiscalPeriodId: string): Promise<PeriodBasis | null> {
  const rows = (await sql`
    SELECT fp.start_date, fp.end_date,
           c.financial_year_start AS fy_start_month
    FROM fiscal_periods fp
    JOIN companies c ON c.id = fp.company_id
    WHERE fp.company_id = ${companyId}::UUID
      AND fp.id = ${fiscalPeriodId}::UUID
    LIMIT 1
  `) as Row[];
  const row = rows[0];
  if (!row) return null;
  const periodStart = fmtDate(row.start_date);
  const periodEnd = fmtDate(row.end_date);
  // READ PATH: the trial balance must still render for a tenant whose
  // financial_year_start was never set, so the March assumption is made HERE,
  // explicitly and visibly, rather than by a COALESCE buried in the query.
  // The close path does NOT get this — see closeReadinessChecks/tbBalancedCheck.ts.
  const fyStartMonth = resolveFiscalYearStartMonth(
    row.fy_start_month,
    companyId,
    { fallback: DEFAULT_FY_START_MONTH },
  );
  return { periodStart, periodEnd, fyStart: fiscalYearStart(periodStart, fyStartMonth) };
}

/**
 * Balances as at the end of `fiscalPeriodId`.
 *
 * Balance-sheet accounts are cumulative from inception; income-statement
 * accounts are year-to-date within the fiscal year containing the period. Each
 * row also carries the opening balance and the period's own debit/credit
 * movement, so opening + movement reconciles to the closing balance.
 */
export async function getTrialBalance(
  companyId: string,
  fiscalPeriodId: string,
  costCentreId?: string,
  options: TrialBalanceOptions = {},
): Promise<TrialBalanceRow[]> {
  const basis = await loadPeriodBasis(companyId, fiscalPeriodId);
  if (!basis) return [];
  return rowsForBasis(companyId, basis, { ...options, costCentreId });
}

/** Shared by `getTrialBalance` and `getTrialBalanceReport` so the period is loaded once. */
async function rowsForBasis(
  companyId: string,
  basis: PeriodBasis,
  options: TrialBalanceOptions,
): Promise<TrialBalanceRow[]> {
  const { costCentreId } = options;
  try {
    const { periodStart, periodEnd, fyStart } = basis;
    // The selector contains both CC types; legacy attribution is independent.
    const ccId = costCentreId ?? null;

    const rows = (await sql`
      SELECT ga.account_code, ga.account_name, ga.account_type, ga.normal_balance,
        COALESCE(SUM(CASE WHEN ga.account_type IN ('asset', 'liability', 'equity')
                            OR je.entry_date >= ${fyStart}
                          THEN jl.debit ELSE 0 END), 0) AS closing_debit,
        COALESCE(SUM(CASE WHEN ga.account_type IN ('asset', 'liability', 'equity')
                            OR je.entry_date >= ${fyStart}
                          THEN jl.credit ELSE 0 END), 0) AS closing_credit,
        COALESCE(SUM(CASE WHEN je.entry_date >= ${periodStart} THEN jl.debit ELSE 0 END), 0) AS period_debit,
        COALESCE(SUM(CASE WHEN je.entry_date >= ${periodStart} THEN jl.credit ELSE 0 END), 0) AS period_credit
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
      WHERE je.status = 'posted'
        AND je.company_id = ${companyId}::UUID
        AND jl.company_id = ${companyId}::UUID
        AND je.entry_date <= ${periodEnd}
        AND (${ccId}::TEXT IS NULL OR jl.cost_center_id = ${ccId}::UUID
          OR jl.cc1_id = ${ccId}::UUID OR jl.cc2_id = ${ccId}::UUID)
      GROUP BY ga.id, ga.account_code, ga.account_name, ga.account_type, ga.normal_balance
      ORDER BY ga.account_code
    `) as Row[];

    const result = options.includeZeroBalances
      ? rows.map(toTrialBalanceRow)
      : rows.map(toTrialBalanceRow).filter(isNonEmpty);

    const broughtForward = await getRetainedEarningsBroughtForward(companyId, fyStart, costCentreId);
    if (Math.abs(broughtForward) >= 0.01) {
      appendBroughtForward(result, fyStart, broughtForward);
      result.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
    }

    return result;
  } catch (err) {
    log.error('Failed to get trial balance', { basis, error: err }, 'accounting');
    throw err;
  }
}

function toTrialBalanceRow(r: Row): TrialBalanceRow {
  const periodDebit = round2(Number(r.period_debit));
  const periodCredit = round2(Number(r.period_credit));
  const closingNet = round2(Number(r.closing_debit) - Number(r.closing_credit));
  const closing = splitNet(closingNet);
  const opening = splitNet(closingNet - (periodDebit - periodCredit));
  return {
    accountCode: String(r.account_code),
    accountName: String(r.account_name),
    accountType: String(r.account_type),
    normalBalance: String(r.normal_balance) as 'debit' | 'credit',
    debitBalance: closing.debit,
    creditBalance: closing.credit,
    openingDebit: opening.debit,
    openingCredit: opening.credit,
    periodDebit,
    periodCredit,
  };
}

/**
 * Drop accounts that neither carry a balance nor moved. An account whose gross
 * turnover nets to zero within the range is genuinely dormant here; an account
 * that moved at all is kept so the movement columns stay complete.
 */
function isNonEmpty(row: TrialBalanceRow): boolean {
  return row.debitBalance !== 0 || row.creditBalance !== 0
    || row.periodDebit !== 0 || row.periodCredit !== 0;
}

/**
 * Append the profit earned before this fiscal year as its own derived row.
 *
 * The ledger has no year-end closing journals, so without this the income
 * statement accounts' pre-year movement would simply vanish and the trial
 * balance would be out of balance by exactly that amount. It is NOT merged
 * into the company's posted retained-earnings account: every posted row here
 * ties to the ledger, and the one figure that does not is labelled as such —
 * see BROUGHT_FORWARD_CODE.
 */
function appendBroughtForward(
  rows: TrialBalanceRow[],
  fyStart: string,
  broughtForward: number,
): void {
  const { accountCode, accountName } = broughtForwardLine(fyStart);
  const split = splitNet(-broughtForward);
  rows.push({
    accountCode,
    accountName,
    accountType: 'equity',
    normalBalance: 'credit',
    derived: true,
    debitBalance: split.debit,
    creditBalance: split.credit,
    openingDebit: split.debit,
    openingCredit: split.credit,
    periodDebit: 0,
    periodCredit: 0,
  });
}

/**
 * The trial balance as a report: rows PLUS the balanced assertion over exactly
 * those rows. Prefer this over `getTrialBalance` — it is the one place
 * `totalDebit` / `totalCredit` / `difference` / `balanced` are computed, so the
 * UI, the CSV export and any MCP tool cannot disagree with each other about
 * whether a given trial balance balances.
 */
export async function getTrialBalanceReport(
  companyId: string,
  fiscalPeriodId: string,
  options: TrialBalanceOptions = {},
): Promise<TrialBalanceReport> {
  const basis = await loadPeriodBasis(companyId, fiscalPeriodId);
  const rows = basis ? await rowsForBasis(companyId, basis, options) : [];

  // The balanced test runs on the RAW sums. Rounding each total to cents first
  // hides sub-cent drift inside the rounding — and worse, can manufacture a cent
  // of difference between two sums that were equal. Round only to present.
  const rawDebit = rows.reduce((sum, r) => sum + r.debitBalance, 0);
  const rawCredit = rows.reduce((sum, r) => sum + r.creditBalance, 0);
  const rawDifference = rawDebit - rawCredit;

  return {
    fiscalPeriodId,
    asAtDate: basis?.periodEnd ?? '',
    periodStart: basis?.periodStart ?? '',
    periodEnd: basis?.periodEnd ?? '',
    fiscalYearStart: basis?.fyStart ?? '',
    costCentreId: options.costCentreId,
    rows,
    accountCount: rows.length,
    totalDebit: round2(rawDebit),
    totalCredit: round2(rawCredit),
    difference: round2(rawDifference),
    balanced: Math.abs(rawDifference) < BALANCE_TOLERANCE,
  };
}
