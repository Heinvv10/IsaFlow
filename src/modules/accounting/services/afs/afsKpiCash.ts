// src/modules/accounting/services/afs/afsKpiCash.ts
/**
 * The KPI block's cash figures, on the SAME definition the cash-flow statement
 * uses. Their own file because `afsKpiService` is at the 300-line limit and
 * because the definition — not the KPI arithmetic — is the thing that has to
 * stay in step with `cashBalanceService`.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { CASH_SUBTYPES } from '../gl/accountSubtypes';

type Row = DbRow;

/**
 * Opening cash, on the SAME definition the cash-flow statement uses.
 *
 * The literal `account_subtype = 'bank'` missed petty cash (subtype `cash`) and
 * counted a credit card spelled `bank_account` as cash, so the KPI block and the
 * cash-flow reconciliation printed beside it in the same AFS export disagreed by
 * exactly those balances. `CASH_SUBTYPES` plus `account_type = 'asset'` is the
 * definition `cashBalanceService`, `cashFlowDirectService` and
 * `cashFlowReconciliationService` all carry.
 */
export async function fetchOpeningCash(companyId: string, beforeDate: string): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(
      CASE WHEN ga.normal_balance = 'debit' THEN jl.debit - jl.credit ELSE jl.credit - jl.debit END
    ), 0)::numeric AS balance
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE ga.account_subtype = ANY(${CASH_SUBTYPES as string[]})
      AND ga.account_type = 'asset'
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND je.entry_date < ${beforeDate}::date
  `) as Row[];

  return Number(rows[0]?.balance ?? 0);
}

export async function fetchClosingCash(companyId: string, upToDate: string): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(
      CASE WHEN ga.normal_balance = 'debit' THEN jl.debit - jl.credit ELSE jl.credit - jl.debit END
    ), 0)::numeric AS balance
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE ga.account_subtype = ANY(${CASH_SUBTYPES as string[]})
      AND ga.account_type = 'asset'
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND je.status = 'posted'
      AND je.entry_date <= ${upToDate}::date
  `) as Row[];

  return Number(rows[0]?.balance ?? 0);
}
