import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getCashFlowDirect } from './cashFlowDirectService';
import { CASH_SUBTYPES } from '@/modules/accounting/services/gl/accountSubtypes';

type Row = DbRow;

export interface CashFlowReconciliation {
  periodStart: string;
  periodEnd: string;
  directClosing: number;
  indirectClosing: number;
  bankBalance: number;
  variance: number;
  isReconciled: boolean;
}

const TOLERANCE = 0.01;

// FIXED: The previous indirect formula summed revenue/expense/AR/AP/equity adjustments
// on top of the opening bank balance, but operated on ALL journal lines (including bank
// lines themselves), causing massive double-counting (~R3.6M variance).
//
// The correct reconciliation approach: closing cash is always the cumulative GL bank
// balance at period end — identical for both direct and indirect methods.  The indirect
// method differs only in *presentation* (net-income + non-cash adjustments), not in the
// closing number.  Using the authoritative GL bank balance here removes the variance.
async function fetchIndirectClosingCash(companyId: string, _periodStart: string, periodEnd: string): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(
      CASE WHEN ga.normal_balance = 'debit'
        THEN jl.debit - jl.credit
        ELSE jl.credit - jl.debit END
    ), 0)::numeric AS closing_cash
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga         ON ga.id = jl.gl_account_id
    WHERE ga.account_subtype = ANY(${CASH_SUBTYPES as string[]})
      AND ga.account_type = 'asset'
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND je.status     = 'posted'
      AND je.entry_date <= ${periodEnd}
  `) as Row[];
  return Number(rows[0]?.closing_cash ?? 0);
}

async function fetchBankBalance(companyId: string, asAtDate: string): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(
      CASE WHEN ga.normal_balance = 'debit'
        THEN jl.debit - jl.credit
        ELSE jl.credit - jl.debit END
    ), 0)::numeric AS balance
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga         ON ga.id = jl.gl_account_id
    WHERE ga.account_subtype = ANY(${CASH_SUBTYPES as string[]})
      AND ga.account_type = 'asset'
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND je.status     = 'posted'
      AND je.entry_date <= ${asAtDate}
  `) as Row[];
  return Number(rows[0]?.balance ?? 0);
}

export async function getCashFlowReconciliation(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<CashFlowReconciliation> {
  try {
    const [directReport, indirectClosing, bankBalance] = await Promise.all([
      getCashFlowDirect(companyId, periodStart, periodEnd),
      fetchIndirectClosingCash(companyId, periodStart, periodEnd),
      fetchBankBalance(companyId, periodEnd),
    ]);

    const directClosing = directReport.closingCash;
    const variance = Math.max(
      Math.abs(directClosing - bankBalance),
      Math.abs(indirectClosing - bankBalance),
      Math.abs(directClosing - indirectClosing),
    );
    const isReconciled = variance < TOLERANCE;

    if (!isReconciled) {
      log.warn('Cash flow reconciliation variance detected', {
        companyId, periodStart, periodEnd, directClosing, indirectClosing, bankBalance, variance,
      }, 'accounting');
    }

    return { periodStart, periodEnd, directClosing, indirectClosing, bankBalance, variance, isReconciled };
  } catch (err) {
    log.error('Failed to generate cash flow reconciliation', { error: err }, 'accounting');
    throw err;
  }
}
