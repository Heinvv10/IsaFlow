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
      SELECT sa.sage_id, sa.account_name AS sage_name, sa.account_code AS sage_code, sa.balance,
        ga.account_code, ga.account_name, ga.id AS gl_id
      FROM sage_accounts sa LEFT JOIN gl_accounts ga ON ga.id = sa.gl_account_id AND ga.company_id = sa.company_id
      WHERE sa.company_id = ${companyId}::UUID ORDER BY ga.account_code NULLS LAST, sa.account_code
    `) as Row[];

    const glBalances = (await sql`
      SELECT ga.id, ga.account_code, ga.account_name, ga.normal_balance, ga.level,
        COALESCE(SUM(CASE WHEN je.id IS NULL THEN 0 ELSE jl.debit END), 0) AS total_debit,
        COALESCE(SUM(CASE WHEN je.id IS NULL THEN 0 ELSE jl.credit END), 0) AS total_credit
      FROM gl_accounts ga
      LEFT JOIN gl_journal_lines jl ON jl.gl_account_id = ga.id AND jl.company_id = ${companyId}::UUID
      LEFT JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'posted' AND je.company_id = ${companyId}::UUID
      WHERE ga.company_id = ${companyId}::UUID GROUP BY ga.id, ga.account_code, ga.account_name, ga.normal_balance, ga.level ORDER BY ga.account_code
    `) as Row[];

    // Every account is compared at any level (a flat chart is all level 1; a header can carry its own lines). Lines
    // are summed per account, never rolled up, so no balance is counted twice. The count is leaves plus any header
    // with activity.
    const glMap = new Map<string, number>();
    let glTotalDebit = 0; let glTotalCredit = 0; let glAccountCount = 0;
    for (const gl of glBalances) {
      const d = Number(gl.total_debit), c = Number(gl.total_credit);
      if (Number(gl.level) >= 3 || d !== 0 || c !== 0) glAccountCount++;
      glMap.set(String(gl.id), String(gl.normal_balance) === 'debit' ? d - c : c - d);
      glTotalDebit += d; glTotalCredit += c;
    }

    const differences: ComparisonReport['differences'] = [];
    let sageTotalDebit = 0; let sageTotalCredit = 0;
    // Several Sage accounts can map to one GL account: their balances are summed and compared once.
    const sageByGl = new Map<string, number>();
    for (const sage of sageBalances) {
      const sb = Number(sage.balance || 0);
      if (sb > 0) sageTotalDebit += sb; else sageTotalCredit += Math.abs(sb);
      if (sage.gl_id == null) {
        // A Sage balance no GL account is mapped to: nothing in the ledger answers for it.
        if (Math.abs(sb) > 0.01) {
          differences.push({
            accountCode: String(sage.sage_code ?? sage.sage_id), accountName: `${sage.sage_name} (no GL account mapped)`,
            sageBalance: sb, glBalance: 0, difference: sb, kind: 'sage_unmapped',
          });
        }
        continue;
      }
      sageByGl.set(String(sage.gl_id), (sageByGl.get(String(sage.gl_id)) ?? 0) + sb);
    }
    const mappedGl = new Set(sageByGl.keys());
    // Walk the MAPPED accounts, not the leaf list: a Sage account can be mapped to a header (level 1-2) account the
    // ledger query does not list, whose balance here is then 0.
    const glNames = new Map(sageBalances.filter((r) => r.gl_id != null).map((r) => [String(r.gl_id), r]));
    for (const [glId, sb] of sageByGl) {
      const gb = glMap.get(glId) ?? 0;
      if (Math.abs(sb - gb) > 0.01) {
        const gl = glNames.get(glId)!;
        differences.push({
          accountCode: String(gl.account_code), accountName: String(gl.account_name), sageBalance: sb, glBalance: gb, difference: sb - gb,
        });
      }
    }

    // A ledger balance no Sage account is mapped to: the source does not carry it.
    for (const gl of glBalances) {
      const gb = glMap.get(String(gl.id)) || 0;
      if (mappedGl.has(String(gl.id)) || Math.abs(gb) <= 0.01) continue;
      differences.push({
        accountCode: String(gl.account_code), accountName: `${gl.account_name} (no Sage account mapped)`,
        sageBalance: 0, glBalance: gb, difference: -gb, kind: 'gl_unmapped',
      });
    }

    const report: ComparisonReport = {
      comparisonDate: new Date().toISOString().slice(0, 10),
      sageTotals: { totalDebit: sageTotalDebit, totalCredit: sageTotalCredit, accountCount: sageBalances.length },
      glTotals: { totalDebit: glTotalDebit, totalCredit: glTotalCredit, accountCount: glAccountCount },
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
