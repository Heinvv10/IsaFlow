// src/modules/accounting/services/afs/afsMappingQueries.ts
// Read-only and leaf-level DB access for AFS mappings.
// Owns getStatementLines, getUnmappedAccounts, mapAccount so afsAutoMapper
// can depend on this module without importing from afsMappingService.

import { sql } from '@/lib/neon';
import type {
  AfsLineSection,
  AfsStatementLine,
  AfsAccountMapping,
  MappedTrialBalanceLine,
} from './afsMappingTypes';

// ── Row mappers ───────────────────────────────────────────────────────────────

function rowToLine(r: Record<string, unknown>): AfsStatementLine {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    code: String(r.code),
    section: r.section as AfsLineSection,
    label: String(r.label),
    parentCode: (r.parent_code as string | null) ?? null,
    noteNumber: r.note_number != null ? Number(r.note_number) : null,
    sortOrder: Number(r.sort_order),
    combineGroup: (r.combine_group as string | null) ?? null,
    isHeader: Boolean(r.is_header),
    isTotal: Boolean(r.is_total),
    isActive: Boolean(r.is_active),
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at as string),
    updatedAt: r.updated_at instanceof Date ? r.updated_at : new Date(r.updated_at as string),
  };
}

function rowToMapping(r: Record<string, unknown>): AfsAccountMapping {
  return {
    id: String(r.id),
    companyId: String(r.company_id),
    glAccountId: String(r.gl_account_id),
    afsLineCode: String(r.afs_line_code),
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at as string),
    updatedAt: r.updated_at instanceof Date ? r.updated_at : new Date(r.updated_at as string),
  };
}

// ── Statement Lines ──────────────────────────────────────────────────────────

export async function getStatementLines(
  companyId: string,
  section?: AfsLineSection,
): Promise<AfsStatementLine[]> {
  const rows = section
    ? await sql`
        SELECT * FROM afs_statement_lines
        WHERE company_id = ${companyId} AND section = ${section}
        ORDER BY sort_order`
    : await sql`
        SELECT * FROM afs_statement_lines
        WHERE company_id = ${companyId}
        ORDER BY section, sort_order`;
  return rows.map(rowToLine);
}

// ── Unmapped Accounts + Mapping (used by auto-mapper) ────────────────────────

export async function getUnmappedAccounts(companyId: string): Promise<Array<{
  id: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  accountSubtype: string | null;
}>> {
  // An inactive account is normally not worth offering for mapping -- is_active
  // is the chart-of-accounts picker flag. But getMappedTrialBalance reads every
  // MAPPED account regardless of is_active, so an inactive account that carries
  // posted activity and is excluded here can never be mapped, and its balance
  // silently misses the financial statements. Confirmed in production: four
  // deactivated Brightsphere accounts held R137,317.39 between them, none of
  // them mappable. So: offer active accounts, plus inactive ones with posted
  // GL activity. Dormant inactive accounts stay out of the work queue.
  const rows = await sql`
    SELECT a.id, a.account_code, a.account_name, a.account_type, a.account_subtype
    FROM gl_accounts a
    WHERE a.company_id = ${companyId}
      AND (a.is_active = true OR EXISTS (
        SELECT 1 FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        WHERE jl.gl_account_id = a.id AND jl.company_id = a.company_id
          AND je.company_id = a.company_id AND je.status = 'posted'
      ))
      AND NOT EXISTS (
        SELECT 1 FROM afs_account_mappings m
        WHERE m.company_id = a.company_id AND m.gl_account_id = a.id
      )
    ORDER BY a.account_code`;
  return rows.map((r) => ({
    id: String(r.id),
    accountCode: String(r.account_code),
    accountName: String(r.account_name),
    accountType: String(r.account_type),
    accountSubtype: (r.account_subtype as string | null) ?? null,
  }));
}

export async function mapAccount(
  companyId: string,
  glAccountId: string,
  afsLineCode: string,
): Promise<AfsAccountMapping> {
  const rows = await sql`
    INSERT INTO afs_account_mappings (company_id, gl_account_id, afs_line_code)
    VALUES (${companyId}, ${glAccountId}, ${afsLineCode})
    ON CONFLICT (company_id, gl_account_id)
    DO UPDATE SET afs_line_code = EXCLUDED.afs_line_code
    RETURNING *`;
  return rowToMapping(rows[0]!);
}

// ── Mapped Trial Balance ──────────────────────────────────────────────────────

export async function getMappedTrialBalance(
  companyId: string,
  fiscalPeriodId: string,
  priorPeriodId?: string,
): Promise<MappedTrialBalanceLine[]> {
  const lines = await getStatementLines(companyId);
  const activeLines = lines.filter((l) => l.isActive);

  // Derive balances from posted journal lines (source of truth) rather than the
  // gl_account_balances cache. That cache is maintained only by a gl_journal_lines
  // trigger that skips non-posted entries and is never refreshed when an entry
  // flips draft -> posted, so it silently drops rows -> understated statements.
  const currentRows = await sql`
    SELECT
      m.afs_line_code,
      m.gl_account_id,
      a.account_code,
      a.account_name,
      COALESCE(b.debit_total, 0) - COALESCE(b.credit_total, 0) AS balance
    FROM afs_account_mappings m
    JOIN gl_accounts a ON a.id = m.gl_account_id AND a.company_id = m.company_id
    LEFT JOIN (
      SELECT jl.gl_account_id,
             SUM(jl.debit) AS debit_total,
             SUM(jl.credit) AS credit_total
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.company_id = ${companyId}
        AND jl.company_id = ${companyId}
        AND je.fiscal_period_id = ${fiscalPeriodId}
        AND je.status = 'posted'
      GROUP BY jl.gl_account_id
    ) b ON b.gl_account_id = m.gl_account_id
    WHERE m.company_id = ${companyId}
    ORDER BY m.afs_line_code, a.account_code`;

  const priorMap = new Map<string, number>();
  if (priorPeriodId) {
    const priorRows = await sql`
      SELECT
        m.gl_account_id,
        COALESCE(b.debit_total, 0) - COALESCE(b.credit_total, 0) AS balance
      FROM afs_account_mappings m
      LEFT JOIN (
        SELECT jl.gl_account_id,
               SUM(jl.debit) AS debit_total,
               SUM(jl.credit) AS credit_total
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        WHERE je.company_id = ${companyId}
          AND jl.company_id = ${companyId}
          AND je.fiscal_period_id = ${priorPeriodId}
          AND je.status = 'posted'
        GROUP BY jl.gl_account_id
      ) b ON b.gl_account_id = m.gl_account_id
      WHERE m.company_id = ${companyId}`;
    for (const r of priorRows) {
      priorMap.set(String(r.gl_account_id), Number(r.balance));
    }
  }

  const accountsByCode = new Map<string, MappedTrialBalanceLine['accounts']>();
  for (const r of currentRows) {
    const code = String(r.afs_line_code);
    if (!accountsByCode.has(code)) accountsByCode.set(code, []);
    accountsByCode.get(code)!.push({
      glAccountId: String(r.gl_account_id),
      accountCode: String(r.account_code),
      accountName: String(r.account_name),
      currentBalance: Number(r.balance),
      priorBalance: priorMap.get(String(r.gl_account_id)) ?? 0,
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
      -- Same mappable set as getUnmappedAccounts, so coverage never reports
      -- more mapped accounts than the denominator admits.
      (SELECT COUNT(*) FROM gl_accounts a
        WHERE a.company_id = ${companyId}
          AND (a.is_active = true OR EXISTS (
            SELECT 1 FROM gl_journal_lines jl
            JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
            WHERE jl.gl_account_id = a.id AND jl.company_id = a.company_id
              AND je.company_id = a.company_id AND je.status = 'posted'
          )))::int AS total_accounts,
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
