/**
 * Trial balance balanced close-readiness check.
 *
 * Verifies that the sum of debits equals the sum of credits for all posted
 * journal entries in this fiscal period.  Any difference > 0.01 ZAR is a fail.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { ChecklistItem } from '../periodCloseReadinessService';

type Row = DbRow;

const TB_BALANCE_TOLERANCE = 0.01;

export async function tbBalancedCheck(
  companyId: string,
  period: { id: string },
): Promise<ChecklistItem> {
  const rows = (await sql`
    SELECT
      COALESCE(SUM(jl.debit), 0)  AS total_debit,
      COALESCE(SUM(jl.credit), 0) AS total_credit
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    WHERE je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND je.fiscal_period_id = ${period.id}::UUID
      AND je.status = 'posted'
  `) as Row[];

  const totalDebit = Number(rows[0]?.total_debit ?? 0);
  const totalCredit = Number(rows[0]?.total_credit ?? 0);
  const diff = Math.abs(totalDebit - totalCredit);

  if (diff <= TB_BALANCE_TOLERANCE) {
    return {
      key: 'tb_balanced',
      label: 'Trial balance balanced',
      status: 'pass',
      reason: `Debits and credits both equal R${totalDebit.toFixed(2)}.`,
      fixHref: '/accounting/trial-balance',
    };
  }

  return {
    key: 'tb_balanced',
    label: 'Trial balance balanced',
    status: 'fail',
    reason: `Debits R${totalDebit.toFixed(2)} do not equal credits R${totalCredit.toFixed(2)} — diff R${diff.toFixed(2)}.`,
    fixHref: '/accounting/trial-balance',
  };
}
