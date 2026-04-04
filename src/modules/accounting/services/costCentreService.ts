/**
 * Cost Centre (Analysis Code) Service
 * Phase 5: Custom reporting dimensions for GL entries
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

export type CcType = 'cc1' | 'cc2';

export interface CostCentre {
  id: string;
  code: string;
  name: string;
  description?: string;
  department?: string;
  ccType: CcType;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CostCentreInput {
  code: string;
  name: string;
  description?: string;
  department?: string;
  ccType?: CcType;
}

export async function getCostCentres(companyId: string, activeOnly = false, ccType?: CcType): Promise<CostCentre[]> {
  let rows: Row[];
  if (ccType && activeOnly) {
    rows = (await sql`SELECT * FROM cost_centres WHERE company_id = ${companyId} AND cc_type = ${ccType} AND is_active = true ORDER BY code`) as Record<string, unknown>[];
  } else if (ccType) {
    rows = (await sql`SELECT * FROM cost_centres WHERE company_id = ${companyId} AND cc_type = ${ccType} ORDER BY code`) as Record<string, unknown>[];
  } else if (activeOnly) {
    rows = (await sql`SELECT * FROM cost_centres WHERE company_id = ${companyId} AND is_active = true ORDER BY code`) as Record<string, unknown>[];
  } else {
    rows = (await sql`SELECT * FROM cost_centres WHERE company_id = ${companyId} ORDER BY code`) as Record<string, unknown>[];
  }
  return rows.map(mapRow);
}

export async function getCostCentre(id: string): Promise<CostCentre | null> {
  const rows = (await sql`SELECT * FROM cost_centres WHERE id = ${id}::UUID`) as Record<string, unknown>[];
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function createCostCentre(companyId: string, input: CostCentreInput, _userId: string): Promise<CostCentre> {
  const rows = (await sql`
    INSERT INTO cost_centres (company_id, code, name, description, department, cc_type)
    VALUES (${companyId}, ${input.code}, ${input.name}, ${input.description || null}, ${input.department || null}, ${input.ccType || 'cc1'})
    RETURNING *
  `) as Record<string, unknown>[];
  log.info('Created cost centre', { id: rows[0]!.id, code: input.code }, 'accounting');
  return mapRow(rows[0]!);
}

export async function updateCostCentre(companyId: string, id: string, input: Partial<CostCentreInput>): Promise<CostCentre> {
  const rows = (await sql`
    UPDATE cost_centres SET
      code = COALESCE(${input.code || null}, code),
      name = COALESCE(${input.name || null}, name),
      description = COALESCE(${input.description || null}, description),
      department = COALESCE(${input.department || null}, department)
    WHERE id = ${id}::UUID AND company_id = ${companyId} RETURNING *
  `) as Record<string, unknown>[];
  if (!rows[0]) throw new Error(`Cost centre ${id} not found`);
  return mapRow(rows[0]);
}

export async function toggleCostCentre(companyId: string, id: string, isActive: boolean): Promise<void> {
  await sql`UPDATE cost_centres SET is_active = ${isActive} WHERE id = ${id}::UUID AND company_id = ${companyId}`;
}

export async function deleteCostCentre(companyId: string, id: string): Promise<void> {
  // Check for usage in journal lines
  const usage = (await sql`
    SELECT COUNT(*) as cnt FROM gl_journal_lines WHERE cost_center_id = ${id}::UUID OR cc1_id = ${id}::UUID OR cc2_id = ${id}::UUID
  `) as Record<string, unknown>[];
  if (Number(usage[0]?.cnt) > 0) {
    throw new Error('Cannot delete cost centre that is used in journal entries. Deactivate instead.');
  }
  await sql`DELETE FROM cost_centres WHERE id = ${id}::UUID AND company_id = ${companyId}`;
}

function mapRow(row: Record<string, unknown>): CostCentre {
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    description: row.description ? String(row.description) : undefined,
    department: row.department ? String(row.department) : undefined,
    ccType: (row.cc_type || 'cc1') as CcType,
    isActive: Boolean(row.is_active),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
