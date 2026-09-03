/**
 * Trial balance balanced close-readiness check.
 *
 * Asserts two distinct things, because neither implies the other:
 *
 *   1. The TRIAL BALANCE as at the period end balances — the report this item
 *      is labelled after and links to. It reads `getTrialBalanceReport`, so the
 *      figure here and the figure on /accounting/trial-balance cannot disagree.
 *   2. This period's own postings balance. Two periods whose errors offset
 *      (+R100 in one, −R100 in the next) leave the cumulative trial balance
 *      balanced while the period itself is broken, so the cumulative check
 *      alone would miss it.
 *
 * It used to assert only (2) while carrying (1)'s label and fixHref: a true
 * statement about a report it never looked at.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { getTrialBalanceReport, BALANCE_TOLERANCE } from '../trialBalanceService';
import type { ChecklistItem } from '../periodCloseReadinessService';

type Row = DbRow;

const KEY = 'tb_balanced';
const LABEL = 'Trial balance balanced';
const FIX_HREF = '/accounting/trial-balance';

/** Debit and credit turnover posted INTO this fiscal period. */
async function periodPostings(
  companyId: string,
  periodId: string,
): Promise<{ debit: number; credit: number; diff: number }> {
  const rows = (await sql`
    SELECT
      COALESCE(SUM(jl.debit), 0)  AS total_debit,
      COALESCE(SUM(jl.credit), 0) AS total_credit
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    WHERE je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND je.fiscal_period_id = ${periodId}::UUID
      AND je.status = 'posted'
  `) as Row[];

  const debit = Number(rows[0]?.total_debit ?? 0);
  const credit = Number(rows[0]?.total_credit ?? 0);
  return { debit, credit, diff: Math.abs(debit - credit) };
}

export async function tbBalancedCheck(
  companyId: string,
  period: { id: string },
): Promise<ChecklistItem> {
  const postings = await periodPostings(companyId, period.id);
  const report = await getTrialBalanceReport(companyId, period.id);

  if (!report.balanced) {
    return {
      key: KEY,
      label: LABEL,
      status: 'fail',
      reason:
        `Trial balance at ${report.periodEnd} is out by R${Math.abs(report.difference).toFixed(2)} ` +
        `across ${report.accountCount} accounts ` +
        `(debits R${report.totalDebit.toFixed(2)}, credits R${report.totalCredit.toFixed(2)}).`,
      fixHref: FIX_HREF,
    };
  }

  if (postings.diff >= BALANCE_TOLERANCE) {
    return {
      key: KEY,
      label: LABEL,
      status: 'fail',
      reason:
        `The trial balance balances, but this period's own postings do not: ` +
        `debits R${postings.debit.toFixed(2)} vs credits R${postings.credit.toFixed(2)} ` +
        `— diff R${postings.diff.toFixed(2)}. An offsetting error in another period is hiding it.`,
      fixHref: FIX_HREF,
    };
  }

  return {
    key: KEY,
    label: LABEL,
    status: 'pass',
    reason:
      `Trial balance at ${report.periodEnd} balances at R${report.totalDebit.toFixed(2)} ` +
      `across ${report.accountCount} accounts; this period posted R${postings.debit.toFixed(2)} each side.`,
    fixHref: FIX_HREF,
  };
}
