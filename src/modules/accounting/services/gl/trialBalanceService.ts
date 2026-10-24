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
import { fiscalYearForDate } from './fiscalYearRegistry';
import { fiscalYearEndBefore, fiscalYearStartsWithin } from './fiscalYearCloseRows';
import {
  broughtForwardLine,
  closedOnNormalSide,
  getRetainedEarningsBroughtForward,
  round2,
  splitNet,
} from './trialBalanceBasis';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';

type Row = DbRow;

export interface TrialBalanceOptions {
  costCentreId?: string;
  businessUnitId?: string;
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
  /**
   * First day of the FY containing the period END — the income-statement cut-off for the
   * closing, as every ledger listing (fiscalYearCloseRows). Not the period START: a Jan–Dec
   * period on a March company starts in one fiscal year and ends in the next (D4).
   */
  fyStart: string;
  /** First day of the fiscal year containing the period START — the opening's cut-off. */
  openingFyStart: string;
  /** Last day of each fiscal year that ends inside the period — where the derived closes fall. */
  fiscalYearEndsClosed: string[];
}

async function loadPeriodBasis(companyId: string, fiscalPeriodId: string): Promise<PeriodBasis | null> {
  const rows = (await sql`
    SELECT fp.start_date, fp.end_date
    FROM fiscal_periods fp
    WHERE fp.company_id = ${companyId}::UUID
      AND fp.id = ${fiscalPeriodId}::UUID
    LIMIT 1
  `) as Row[];
  const row = rows[0];
  if (!row) return null;
  const periodStart = fmtDate(row.start_date);
  const periodEnd = fmtDate(row.end_date);
  // The years are the registry's: the year holding the period END cuts the
  // income statement, the year holding the START cuts the opening, and a
  // transition year is one year however long it is.
  const endYear = await fiscalYearForDate(companyId, periodEnd);
  const startYear = await fiscalYearForDate(companyId, periodStart);
  const starts = await fiscalYearStartsWithin(companyId, periodStart, periodEnd);
  return {
    periodStart,
    periodEnd,
    fyStart: endYear.startDate,
    openingFyStart: startYear.startDate,
    fiscalYearEndsClosed: starts.map(fiscalYearEndBefore),
  };
}

/**
 * Balances as at the end of `fiscalPeriodId`: balance-sheet accounts cumulative from
 * inception, income-statement accounts year-to-date within the FY containing the period END.
 * Each row also carries the opening at the period start, the posted movement and the derived
 * year-end close (see toTrialBalanceRow): opening + movement + close = closing.
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
  const { costCentreId, businessUnitId } = options;
  try {
    const { periodStart, periodEnd, fyStart, openingFyStart } = basis;
    // The selector contains both CC types; legacy attribution is independent.
    const ccId = costCentreId ?? null;
    const buId = businessUnitId ?? null;

    const rows = (await sql`
      SELECT ga.account_code, ga.account_name, ga.account_type, ga.normal_balance,
        COALESCE(SUM(CASE WHEN ga.account_type IN ('asset', 'liability', 'equity')
                            OR je.entry_date >= ${fyStart}
                          THEN jl.debit ELSE 0 END), 0) AS closing_debit,
        COALESCE(SUM(CASE WHEN ga.account_type IN ('asset', 'liability', 'equity')
                            OR je.entry_date >= ${fyStart}
                          THEN jl.credit ELSE 0 END), 0) AS closing_credit,
        COALESCE(SUM(CASE WHEN je.entry_date < ${periodStart}
                           AND (ga.account_type IN ('asset', 'liability', 'equity')
                             OR je.entry_date >= ${openingFyStart})
                          THEN jl.debit - jl.credit ELSE 0 END), 0) AS opening_net,
        COALESCE(SUM(CASE WHEN je.entry_date >= ${periodStart} THEN jl.debit ELSE 0 END), 0) AS period_debit,
        COALESCE(SUM(CASE WHEN je.entry_date >= ${periodStart} THEN jl.credit ELSE 0 END), 0) AS period_credit
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
      WHERE je.status = 'posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE}
        AND je.company_id = ${companyId}::UUID
        AND jl.company_id = ${companyId}::UUID
        AND je.entry_date <= ${periodEnd}
        AND (${ccId}::TEXT IS NULL OR jl.cc1_id = ${ccId}::UUID
          OR jl.cc2_id = ${ccId}::UUID)
        AND (${buId}::TEXT IS NULL OR jl.bu_id = ${buId}::UUID)
      GROUP BY ga.id, ga.account_code, ga.account_name, ga.account_type, ga.normal_balance
      ORDER BY ga.account_code
    `) as Row[];

    const result = options.includeZeroBalances
      ? rows.map(toTrialBalanceRow)
      : rows.map(toTrialBalanceRow).filter(isNonEmpty);

    const broughtForward = await getRetainedEarningsBroughtForward(companyId, fyStart, costCentreId, businessUnitId);
    const openingBroughtForward = openingFyStart === fyStart
      ? broughtForward
      : await getRetainedEarningsBroughtForward(companyId, openingFyStart, costCentreId, businessUnitId);
    if (Math.abs(broughtForward) >= 0.01 || Math.abs(openingBroughtForward) >= 0.01) {
      appendBroughtForward(result, fyStart, broughtForward, openingBroughtForward);
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
  // D4 (Hein, 2026-10-02): opening / movement / close / closing are the account ledger's
  // openingBalance / periodNet / closedToRetainedEarnings / periodClosingBalance, so the TB,
  // ledger pages, drill-down and GL report agree column by column. Opening floors at the FY of
  // the period START, closing at the FY of the END; the close bridges them across an FY start.
  const openingNet = round2(Number(r.opening_net));
  const opening = splitNet(openingNet);
  const normalBalance = String(r.normal_balance) as 'debit' | 'credit';
  return {
    accountCode: String(r.account_code),
    accountName: String(r.account_name),
    accountType: String(r.account_type),
    normalBalance,
    debitBalance: closing.debit,
    creditBalance: closing.credit,
    openingDebit: opening.debit,
    openingCredit: opening.credit,
    periodDebit,
    periodCredit,
    closedToRetainedEarnings: closedOnNormalSide(normalBalance, closingNet - openingNet - (periodDebit - periodCredit)),
  };
}

/**
 * Drop accounts that neither carry a balance nor moved. An account whose gross
 * turnover nets to zero within the range is genuinely dormant here; an account
 * that moved at all is kept so the movement columns stay complete. So is one
 * that only OPENS with a balance — an income-statement account closed to zero
 * at a fiscal-year start inside the period — or the opening column would not foot.
 */
function isNonEmpty(row: TrialBalanceRow): boolean {
  return row.debitBalance !== 0 || row.creditBalance !== 0
    || row.periodDebit !== 0 || row.periodCredit !== 0
    || row.openingDebit !== 0 || row.openingCredit !== 0;
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
  openingBroughtForward: number,
): void {
  const { accountCode, accountName } = broughtForwardLine(fyStart);
  const split = splitNet(-broughtForward);
  const opening = splitNet(-openingBroughtForward);
  rows.push({
    accountCode,
    accountName,
    accountType: 'equity',
    normalBalance: 'credit',
    derived: true,
    debitBalance: split.debit,
    creditBalance: split.credit,
    openingDebit: opening.debit,
    openingCredit: opening.credit,
    periodDebit: 0,
    periodCredit: 0,
    // What the fiscal years closed inside the period added to it (credit = profit).
    closedToRetainedEarnings: closedOnNormalSide('credit', openingBroughtForward - broughtForward),
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
    fiscalYearEndsClosed: basis?.fiscalYearEndsClosed ?? [],
    costCentreId: options.costCentreId,
    businessUnitId: options.businessUnitId,
    rows,
    accountCount: rows.length,
    totalDebit: round2(rawDebit),
    totalCredit: round2(rawCredit),
    difference: round2(rawDifference),
    balanced: Math.abs(rawDifference) < BALANCE_TOLERANCE,
  };
}
