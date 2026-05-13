// src/modules/accounting/services/afs/afsMappingService.ts
// AFS Account Mapping Service — maps GL accounts to standardised BS/IS disclosure codes.
// CRUD and DB access only. Auto-mapping logic lives in afsAutoMapper.ts;
// taxonomy seed data lives in afsTaxonomySeeds.ts.

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { BS_LINES, IS_LINES } from './afsTaxonomySeeds';

// ── Types ─────────────────────────────────────────────────────────────────────

export type AfsLineSection = 'balance_sheet' | 'income_statement';

export interface AfsStatementLine {
  id: string;
  companyId: string;
  code: string;
  section: AfsLineSection;
  label: string;
  parentCode: string | null;
  noteNumber: number | null;
  sortOrder: number;
  combineGroup: string | null;
  isHeader: boolean;
  isTotal: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AfsAccountMapping {
  id: string;
  companyId: string;
  glAccountId: string;
  afsLineCode: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MappedAccount extends AfsAccountMapping {
  accountCode: string;
  accountName: string;
  accountType: string;
  accountSubtype: string | null;
}

export interface MappedTrialBalanceLine {
  code: string;
  label: string;
  section: AfsLineSection;
  noteNumber: number | null;
  combineGroup: string | null;
  isHeader: boolean;
  isTotal: boolean;
  parentCode: string | null;
  sortOrder: number;
  currentAmount: number;
  priorAmount: number;
  accounts: Array<{
    glAccountId: string;
    accountCode: string;
    accountName: string;
    currentBalance: number;
    priorBalance: number;
  }>;
}

export interface AutoMapResult {
  mapped: number;
  skipped: number;
  suggestions: Array<{
    glAccountId: string;
    accountCode: string;
    accountName: string;
    suggestedCode: string;
    suggestedLabel: string;
    confidence: 'high' | 'medium' | 'low';
  }>;
}

// ── Row mappers ───────────────────────────────────────────────────────────────

function rowToLine(r: Record<string, unknown>): AfsStatementLine {
  return {
    id: r.id as string,
    companyId: r.company_id as string,
    code: r.code as string,
    section: r.section as AfsLineSection,
    label: r.label as string,
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
    id: r.id as string,
    companyId: r.company_id as string,
    glAccountId: r.gl_account_id as string,
    afsLineCode: r.afs_line_code as string,
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at as string),
    updatedAt: r.updated_at instanceof Date ? r.updated_at : new Date(r.updated_at as string),
  };
}

// ── Statement Lines CRUD ──────────────────────────────────────────────────────

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

export async function upsertStatementLine(
  companyId: string,
  input: {
    code: string;
    section: AfsLineSection;
    label: string;
    parentCode?: string | null;
    noteNumber?: number | null;
    sortOrder: number;
    combineGroup?: string | null;
    isHeader?: boolean;
    isTotal?: boolean;
    isActive?: boolean;
  },
): Promise<AfsStatementLine> {
  const rows = await sql`
    INSERT INTO afs_statement_lines
      (company_id, code, section, label, parent_code, note_number,
       sort_order, combine_group, is_header, is_total, is_active)
    VALUES
      (${companyId}, ${input.code}, ${input.section}, ${input.label},
       ${input.parentCode ?? null}, ${input.noteNumber ?? null},
       ${input.sortOrder}, ${input.combineGroup ?? null},
       ${input.isHeader ?? false}, ${input.isTotal ?? false},
       ${input.isActive ?? true})
    ON CONFLICT (company_id, code)
    DO UPDATE SET
      label         = EXCLUDED.label,
      parent_code   = EXCLUDED.parent_code,
      note_number   = EXCLUDED.note_number,
      sort_order    = EXCLUDED.sort_order,
      combine_group = EXCLUDED.combine_group,
      is_header     = EXCLUDED.is_header,
      is_total      = EXCLUDED.is_total,
      is_active     = EXCLUDED.is_active
    RETURNING *`;
  return rowToLine(rows[0]!);
}

export async function toggleStatementLine(
  companyId: string,
  code: string,
  isActive: boolean,
): Promise<void> {
  await sql`
    UPDATE afs_statement_lines
    SET is_active = ${isActive}
    WHERE company_id = ${companyId} AND code = ${code}`;
}

// ── Account Mappings CRUD ─────────────────────────────────────────────────────

export async function getAccountMappings(companyId: string): Promise<MappedAccount[]> {
  const rows = await sql`
    SELECT m.*, a.account_code, a.account_name, a.account_type, a.account_subtype
    FROM afs_account_mappings m
    JOIN gl_accounts a ON a.id = m.gl_account_id AND a.company_id = m.company_id
    WHERE m.company_id = ${companyId}
    ORDER BY m.afs_line_code, a.account_code`;
  return rows.map((r) => ({
    ...rowToMapping(r),
    accountCode: r.account_code as string,
    accountName: r.account_name as string,
    accountType: r.account_type as string,
    accountSubtype: (r.account_subtype as string | null) ?? null,
  }));
}

export async function getUnmappedAccounts(companyId: string): Promise<Array<{
  id: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  accountSubtype: string | null;
}>> {
  const rows = await sql`
    SELECT a.id, a.account_code, a.account_name, a.account_type, a.account_subtype
    FROM gl_accounts a
    WHERE a.company_id = ${companyId}
      AND a.is_active = true
      AND NOT EXISTS (
        SELECT 1 FROM afs_account_mappings m
        WHERE m.company_id = a.company_id AND m.gl_account_id = a.id
      )
    ORDER BY a.account_code`;
  return rows.map((r) => ({
    id: r.id as string,
    accountCode: r.account_code as string,
    accountName: r.account_name as string,
    accountType: r.account_type as string,
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

export async function unmapAccount(companyId: string, glAccountId: string): Promise<void> {
  await sql`
    DELETE FROM afs_account_mappings
    WHERE company_id = ${companyId} AND gl_account_id = ${glAccountId}`;
}

export async function bulkMapAccounts(
  companyId: string,
  mappings: Array<{ glAccountId: string; afsLineCode: string }>,
): Promise<number> {
  if (mappings.length === 0) return 0;
  let count = 0;
  for (const m of mappings) {
    await sql`
      INSERT INTO afs_account_mappings (company_id, gl_account_id, afs_line_code)
      VALUES (${companyId}, ${m.glAccountId}, ${m.afsLineCode})
      ON CONFLICT (company_id, gl_account_id)
      DO UPDATE SET afs_line_code = EXCLUDED.afs_line_code`;
    count++;
  }
  return count;
}

// ── Re-exports: complex queries and auto-mapper ───────────────────────────────
// Callers importing these from afsMappingService continue to work without path changes.
export { getMappedTrialBalance, getMappingStats } from './afsMappingQueries';
export { autoMapAccounts } from './afsAutoMapper';

// ── Seed Default Taxonomy ─────────────────────────────────────────────────────

export async function seedDefaultTaxonomy(companyId: string): Promise<{ created: number; existing: number }> {
  const existing = await getStatementLines(companyId);
  const existingCodes = new Set(existing.map((l) => l.code));

  let created = 0;
  let skipped = 0;
  const allLines = [...BS_LINES, ...IS_LINES];

  for (let i = 0; i < allLines.length; i++) {
    const line = allLines[i]!;
    if (existingCodes.has(line.code)) {
      skipped++;
      continue;
    }
    await upsertStatementLine(companyId, {
      code: line.code,
      section: line.section,
      label: line.label,
      parentCode: line.parentCode ?? null,
      noteNumber: line.noteNumber ?? null,
      sortOrder: (i + 1) * 10,
      combineGroup: line.combineGroup ?? null,
      isHeader: line.isHeader ?? false,
      isTotal: line.isTotal ?? false,
      isActive: true,
    });
    created++;
  }

  log.info('afsMappingService.seedDefaultTaxonomy', { companyId, created, existing: skipped });
  return { created, existing: skipped };
}

