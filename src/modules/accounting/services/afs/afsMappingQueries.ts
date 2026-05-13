// src/modules/accounting/services/afs/afsMappingQueries.ts
// Complex read-only queries against AFS mapping tables.
// Imported by afsMappingService (re-exported) and directly by API routes.

import { sql } from '@/lib/neon';
import { getStatementLines } from './afsMappingService';
import type { AfsLineSection, MappedTrialBalanceLine } from './afsMappingService';

// ── Mapped Trial Balance ──────────────────────────────────────────────────────

export async function getMappedTrialBalance(
  companyId: string,
  fiscalPeriodId: string,
  priorPeriodId?: string,
): Promise<MappedTrialBalanceLine[]> {
  const lines = await getStatementLines(companyId);
  const activeLines = lines.filter((l) => l.isActive);

  const currentRows = await sql`
    SELECT
      m.afs_line_code,
      m.gl_account_id,
      a.account_code,
      a.account_name,
      COALESCE(b.debit_total, 0) - COALESCE(b.credit_total, 0) AS balance
    FROM afs_account_mappings m
    JOIN gl_accounts a ON a.id = m.gl_account_id AND a.company_id = m.company_id
    LEFT JOIN gl_account_balances b
      ON b.gl_account_id = m.gl_account_id AND b.fiscal_period_id = ${fiscalPeriodId}
    WHERE m.company_id = ${companyId}
    ORDER BY m.afs_line_code, a.account_code`;

  const priorMap = new Map<string, number>();
  if (priorPeriodId) {
    const priorRows = await sql`
      SELECT
        m.gl_account_id,
        COALESCE(b.debit_total, 0) - COALESCE(b.credit_total, 0) AS balance
      FROM afs_account_mappings m
      LEFT JOIN gl_account_balances b
        ON b.gl_account_id = m.gl_account_id AND b.fiscal_period_id = ${priorPeriodId}
      WHERE m.company_id = ${companyId}`;
    for (const r of priorRows) {
      priorMap.set(r.gl_account_id as string, Number(r.balance));
    }
  }

  const accountsByCode = new Map<string, MappedTrialBalanceLine['accounts']>();
  for (const r of currentRows) {
    const code = r.afs_line_code as string;
    if (!accountsByCode.has(code)) accountsByCode.set(code, []);
    accountsByCode.get(code)!.push({
      glAccountId: r.gl_account_id as string,
      accountCode: r.account_code as string,
      accountName: r.account_name as string,
      currentBalance: Number(r.balance),
      priorBalance: priorMap.get(r.gl_account_id as string) ?? 0,
    });
  }

  return activeLines.map((line) => {
    const accounts = accountsByCode.get(line.code) ?? [];
    return {
      code: line.code,
      label: line.label,
      section: line.section as AfsLineSection,
      noteNumber: line.noteNumber,
      combineGroup: line.combineGroup,
      isHeader: line.isHeader,
      isTotal: line.isTotal,
      parentCode: line.parentCode,
      sortOrder: line.sortOrder,
      currentAmount: accounts.reduce((sum, a) => sum + a.currentBalance, 0),
      priorAmount: accounts.reduce((sum, a) => sum + a.priorBalance, 0),
      accounts,
    };
  });
}

// ── Mapping Stats ─────────────────────────────────────────────────────────────

export async function getMappingStats(companyId: string): Promise<{
  totalAccounts: number;
  mappedAccounts: number;
  unmappedAccounts: number;
  totalLines: number;
  activeLines: number;
  linesWithMappings: number;
}> {
  const rows = await sql`
    SELECT
      (SELECT COUNT(*) FROM gl_accounts WHERE company_id = ${companyId} AND is_active = true)::int AS total_accounts,
      (SELECT COUNT(*) FROM afs_account_mappings WHERE company_id = ${companyId})::int AS mapped_accounts,
      (SELECT COUNT(*) FROM afs_statement_lines WHERE company_id = ${companyId})::int AS total_lines,
      (SELECT COUNT(*) FROM afs_statement_lines WHERE company_id = ${companyId} AND is_active = true)::int AS active_lines,
      (SELECT COUNT(DISTINCT afs_line_code) FROM afs_account_mappings WHERE company_id = ${companyId})::int AS lines_with_mappings`;
  const r = rows[0]!;
  const total = Number(r.total_accounts);
  const mapped = Number(r.mapped_accounts);
  return {
    totalAccounts: total,
    mappedAccounts: mapped,
    unmappedAccounts: total - mapped,
    totalLines: Number(r.total_lines),
    activeLines: Number(r.active_lines),
    linesWithMappings: Number(r.lines_with_mappings),
  };
}
