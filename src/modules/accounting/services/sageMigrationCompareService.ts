/**
 * Sage Migration Comparison Service
 * Comparison and reset operations — split from sageMigrationService.ts.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { ComparisonReport } from './sageMigrationService';
type Row = DbRow;

export async function generateComparison(companyId: string, userId: string): Promise<ComparisonReport> {
  try {
    const sageBalances = (await sql`
      SELECT sa.sage_account_id, sa.name, sa.balance, ga.account_code, ga.account_name, ga.id AS gl_id
      FROM sage_accounts sa JOIN gl_accounts ga ON ga.id = sa.gl_account_id
      WHERE sa.company_id = ${companyId}::UUID ORDER BY ga.account_code
    `) as Row[];

    const glBalances = (await sql`
      SELECT ga.id, ga.account_code, ga.account_name, ga.normal_balance,
        COALESCE(SUM(jl.debit), 0) AS total_debit, COALESCE(SUM(jl.credit), 0) AS total_credit
      FROM gl_accounts ga
      LEFT JOIN gl_journal_lines jl ON jl.gl_account_id = ga.id
      LEFT JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'posted'
      WHERE ga.level >= 3 GROUP BY ga.id, ga.account_code, ga.account_name, ga.normal_balance ORDER BY ga.account_code
    `) as Row[];

    const glMap = new Map<string, number>();
    let glTotalDebit = 0; let glTotalCredit = 0;
    for (const gl of glBalances) {
      const d = Number(gl.total_debit), c = Number(gl.total_credit);
      glMap.set(String(gl.id), String(gl.normal_balance) === 'debit' ? d - c : c - d);
      glTotalDebit += d; glTotalCredit += c;
    }

    const differences: ComparisonReport['differences'] = [];
    let sageTotalDebit = 0; let sageTotalCredit = 0;
    for (const sage of sageBalances) {
      const sb = Number(sage.balance || 0), gb = glMap.get(String(sage.gl_id)) || 0;
      if (sb > 0) sageTotalDebit += sb; else sageTotalCredit += Math.abs(sb);
      if (Math.abs(sb - gb) > 0.01) {
        differences.push({
          accountCode: String(sage.account_code),
          accountName: String(sage.account_name),
          sageBalance: sb,
          glBalance: gb,
          difference: sb - gb,
        });
      }
    }

    const report: ComparisonReport = {
      comparisonDate: new Date().toISOString().slice(0, 10),
      sageTotals: { totalDebit: sageTotalDebit, totalCredit: sageTotalCredit, accountCount: sageBalances.length },
      glTotals: { totalDebit: glTotalDebit, totalCredit: glTotalCredit, accountCount: glBalances.length },
      differences,
      isBalanced: differences.length === 0,
    };

    await sql`
      INSERT INTO gl_migration_comparisons (company_id, comparison_date, sage_totals, gl_totals, differences, is_balanced, created_by)
      VALUES (${companyId}::UUID, ${report.comparisonDate}, ${JSON.stringify(report.sageTotals)}, ${JSON.stringify(report.glTotals)},
        ${JSON.stringify(report.differences)}, ${report.isBalanced}, ${userId})
    `;
    return report;
  } catch (err) {
    log.error('Failed to generate comparison', { error: err }, 'accounting');
    throw err;
  }
}

export async function resetMigration(
  companyId: string,
  runType: 'accounts' | 'ledger' | 'invoices' | 'customer_invoices',
): Promise<void> {
  if (runType === 'accounts') {
    await sql`UPDATE sage_accounts SET gl_account_id = NULL, mapping_status = 'unmapped', mapping_notes = NULL WHERE company_id = ${companyId}::UUID`;
  } else if (runType === 'ledger') {
    await sql`UPDATE sage_ledger_transactions SET migration_status = 'pending', gl_journal_entry_id = NULL WHERE company_id = ${companyId}::UUID`;
  } else if (runType === 'invoices') {
    await sql`UPDATE sage_supplier_invoices SET migration_status = 'pending', gl_supplier_invoice_id = NULL WHERE company_id = ${companyId}::UUID`;
  } else if (runType === 'customer_invoices') {
    await sql`UPDATE sage_customer_invoices SET migration_status = 'pending', gl_customer_invoice_id = NULL WHERE company_id = ${companyId}::UUID`;
  }
}
