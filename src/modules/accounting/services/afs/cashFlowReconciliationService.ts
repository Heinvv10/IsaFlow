import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getCashFlowDirect } from './cashFlowDirectService';

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

async function fetchIndirectClosingCash(companyId: string, periodStart: string, periodEnd: string): Promise<number> {
  const rows = (await sql`
    SELECT
      (
        (SELECT COALESCE(SUM(
          CASE WHEN ga_o.normal_balance = 'debit'
            THEN jl_o.debit - jl_o.credit
            ELSE jl_o.credit - jl_o.debit END
        ), 0) FROM gl_journal_lines jl_o
         JOIN gl_journal_entries je_o ON je_o.id = jl_o.journal_entry_id
         JOIN gl_accounts ga_o         ON ga_o.id = jl_o.gl_account_id
         WHERE ga_o.account_subtype = 'bank'
           AND ga_o.company_id = ${companyId}::UUID
           AND je_o.company_id = ${companyId}::UUID
           AND jl_o.company_id = ${companyId}::UUID
           AND je_o.status     = 'posted'
           AND je_o.entry_date < ${periodStart})
        + COALESCE(SUM(CASE WHEN ga.account_type = 'revenue' THEN jl.credit - jl.debit END), 0)
        - COALESCE(SUM(CASE WHEN ga.account_type = 'expense' THEN jl.debit - jl.credit END), 0)
        + COALESCE(SUM(CASE WHEN ga.account_subtype = 'receivable' THEN jl.credit - jl.debit END), 0)
        + COALESCE(SUM(CASE WHEN ga.account_subtype = 'payable' THEN jl.credit - jl.debit END), 0)
        + COALESCE(SUM(CASE WHEN ga.account_subtype IN ('fixed_asset', 'other_asset')
                            THEN jl.credit - jl.debit END), 0)
        + COALESCE(SUM(CASE WHEN ga.account_type = 'equity'
                             AND (ga.account_subtype IS NULL OR ga.account_subtype != 'retained_earnings')
                            THEN jl.credit - jl.debit END), 0)
      )::numeric AS closing_cash
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga         ON ga.id = jl.gl_account_id
    WHERE je.status     = 'posted'
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND je.entry_date >= ${periodStart}
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
    WHERE ga.account_subtype = 'bank'
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
