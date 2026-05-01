/**
 * Trial Balance Service
 * GL trial balance queries — split from journalEntryCrudService.ts.
 *
 * Returns `TrialBalanceRow[]` — a flat array.
 * The API handler wraps it as `{ rows: TrialBalanceRow[], totalDebit, totalCredit }`.
 * The canonical container key is `rows` (not `accounts`).
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { TrialBalanceRow } from '../../types/gl.types';
type Row = DbRow;

export async function getTrialBalance(
  companyId: string,
  fiscalPeriodId: string,
  costCentreId?: string,
): Promise<TrialBalanceRow[]> {
  try {
    if (!costCentreId) {
      const rows = (await sql`
        SELECT ga.account_code, ga.account_name, ga.account_type, ga.normal_balance,
          COALESCE(SUM(jl.debit), 0) AS debit_balance,
          COALESCE(SUM(jl.credit), 0) AS credit_balance
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE je.status = 'posted'
          AND je.company_id = ${companyId}::UUID
          AND jl.company_id = ${companyId}::UUID
          AND je.fiscal_period_id = ${fiscalPeriodId}::UUID
        GROUP BY ga.id, ga.account_code, ga.account_name, ga.account_type, ga.normal_balance
        HAVING COALESCE(SUM(jl.debit), 0) != 0 OR COALESCE(SUM(jl.credit), 0) != 0
        ORDER BY ga.account_code
      `) as Row[];
      return rows.map(r => ({
        accountCode: String(r.account_code),
        accountName: String(r.account_name),
        accountType: String(r.account_type),
        normalBalance: String(r.normal_balance) as 'debit' | 'credit',
        debitBalance: Number(r.debit_balance),
        creditBalance: Number(r.credit_balance),
      }));
    }

    const rows = (await sql`
      SELECT ga.account_code, ga.account_name, ga.account_type, ga.normal_balance,
        COALESCE(SUM(jl.debit), 0) AS total_debit,
        COALESCE(SUM(jl.credit), 0) AS total_credit
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE je.status = 'posted'
        AND je.company_id = ${companyId}::UUID
        AND jl.company_id = ${companyId}::UUID
        AND je.fiscal_period_id = ${fiscalPeriodId}::UUID
        AND jl.cost_center_id = ${costCentreId}::UUID
      GROUP BY ga.id, ga.account_code, ga.account_name, ga.account_type, ga.normal_balance
      HAVING COALESCE(SUM(jl.debit), 0) != 0 OR COALESCE(SUM(jl.credit), 0) != 0
      ORDER BY ga.account_code
    `) as Row[];

    return rows.map(r => ({
      accountCode: String(r.account_code),
      accountName: String(r.account_name),
      accountType: String(r.account_type),
      normalBalance: String(r.normal_balance) as 'debit' | 'credit',
      debitBalance: Number(r.total_debit),
      creditBalance: Number(r.total_credit),
    }));
  } catch (err) {
    log.error('Failed to get trial balance', { fiscalPeriodId, error: err }, 'accounting');
    throw err;
  }
}
