// src/modules/accounting/services/afs/afsMappingService.ts
// AFS Account Mapping Service — façade over the split AFS mapping modules.
// CRUD that doesn't fit in queries lives here; everything else is re-exported
// so existing callers keep working without path changes.
//
//   afsMappingTypes  ─┬─→  afsMappingQueries  ─→  afsAutoMapper
//                     └─→  afsMappingService (façade) re-exports siblings

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { BS_LINES, IS_LINES } from './afsTaxonomySeeds';
import { getStatementLines } from './afsMappingQueries';
import type {
  AfsLineSection,
  AfsAccountMapping,
  MappedAccount,
} from './afsMappingTypes';

// ── Type re-exports (preserves existing import paths) ─────────────────────────

export type {
  AfsLineSection,
  AfsStatementLine,
  AfsAccountMapping,
  MappedAccount,
  MappedTrialBalanceLine,
  AutoMapResult,
} from './afsMappingTypes';

// ── Function re-exports (preserves existing import paths) ─────────────────────

export {
  getStatementLines,
  getUnmappedAccounts,
  mapAccount,
  getMappedTrialBalance,
  getMappingStats,
} from './afsMappingQueries';
export { autoMapAccounts } from './afsAutoMapper';

// ── Local row mapper for the CRUD this module still owns ──────────────────────

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

// ── Statement Lines write-side ────────────────────────────────────────────────

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
    totalBasis?: 'children' | 'components' | 'running';
    totalComponents?: string[] | null;
  },
): Promise<void> {
  await sql`
    INSERT INTO afs_statement_lines
      (company_id, code, section, label, parent_code, note_number,
       sort_order, combine_group, is_header, is_total, is_active,
       total_basis, total_components)
    VALUES
      (${companyId}, ${input.code}, ${input.section}, ${input.label},
       ${input.parentCode ?? null}, ${input.noteNumber ?? null},
       ${input.sortOrder}, ${input.combineGroup ?? null},
       ${input.isHeader ?? false}, ${input.isTotal ?? false},
       ${input.isActive ?? true},
       ${input.totalBasis ?? 'children'}, ${input.totalComponents ?? null})
    ON CONFLICT (company_id, code)
    DO UPDATE SET
      label         = EXCLUDED.label,
      parent_code   = EXCLUDED.parent_code,
      note_number   = EXCLUDED.note_number,
      sort_order    = EXCLUDED.sort_order,
      combine_group = EXCLUDED.combine_group,
      is_header     = EXCLUDED.is_header,
      is_total      = EXCLUDED.is_total,
      is_active     = EXCLUDED.is_active,
      total_basis      = EXCLUDED.total_basis,
      total_components = EXCLUDED.total_components`;
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

// ── Account Mappings write-side + read-side that joins gl_accounts ────────────

export async function getAccountMappings(companyId: string): Promise<MappedAccount[]> {
  const rows = await sql`
    SELECT m.*, a.account_code, a.account_name, a.account_type, a.account_subtype
    FROM afs_account_mappings m
    JOIN gl_accounts a ON a.id = m.gl_account_id AND a.company_id = m.company_id
    WHERE m.company_id = ${companyId}
    ORDER BY m.afs_line_code, a.account_code`;
  return rows.map((r) => ({
    ...rowToMapping(r),
    accountCode: String(r.account_code),
    accountName: String(r.account_name),
    accountType: String(r.account_type),
    accountSubtype: (r.account_subtype as string | null) ?? null,
  }));
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
