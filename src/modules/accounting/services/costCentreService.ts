/**
 * Cost Centre (Analysis Code) Service
 * Phase 5: Custom reporting dimensions for GL entries
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

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

export async function getCostCentres(activeOnly = false, ccType?: CcType): Promise<CostCentre[]> {
  let rows: Row[];
  if (ccType === 'cc1') {
    rows = activeOnly
      ? ((await sql`SELECT * FROM cost_centres WHERE cc_type = 'cc1' AND is_active = true ORDER BY code`) as Row[])
      : ((await sql`SELECT * FROM cost_centres WHERE cc_type = 'cc1' ORDER BY code`) as Row[]);
  } else if (ccType === 'cc2') {
    rows = activeOnly
      ? ((await sql`SELECT * FROM cost_centres WHERE cc_type = 'cc2' AND is_active = true ORDER BY code`) as Row[])
      : ((await sql`SELECT * FROM cost_centres WHERE cc_type = 'cc2' ORDER BY code`) as Row[]);
  } else {
    rows = activeOnly
      ? ((await sql`SELECT * FROM cost_centres WHERE is_active = true ORDER BY code`) as Row[])
      : ((await sql`SELECT * FROM cost_centres ORDER BY code`) as Row[]);
  }
  return rows.map(mapRow);
}

export async function getCostCentre(id: string): Promise<CostCentre | null> {
  const rows = (await sql`SELECT * FROM cost_centres WHERE id = ${id}::UUID`) as Row[];
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function createCostCentre(input: CostCentreInput, userId: string): Promise<CostCentre> {
  const ccType: CcType = input.ccType || 'cc1';
  const rows = (await sql`
    INSERT INTO cost_centres (code, name, description, department, cc_type, created_by)
    VALUES (${input.code}, ${input.name}, ${input.description || null},
            ${input.department || null}, ${ccType}, ${userId}::UUID)
    RETURNING *
  `) as Row[];
  log.info('Created cost centre', { id: rows[0].id, code: input.code }, 'accounting');
  return mapRow(rows[0]);
}

export async function updateCostCentre(id: string, input: Partial<CostCentreInput>): Promise<CostCentre> {
  const rows = (await sql`
    UPDATE cost_centres SET
      code = COALESCE(${input.code || null}, code),
      name = COALESCE(${input.name || null}, name),
      description = COALESCE(${input.description || null}, description),
      department = COALESCE(${input.department || null}, department)
    WHERE id = ${id}::UUID RETURNING *
  `) as Row[];
  if (!rows[0]) throw new Error(`Cost centre ${id} not found`);
  return mapRow(rows[0]);
}

export async function toggleCostCentre(id: string, isActive: boolean): Promise<void> {
  await sql`UPDATE cost_centres SET is_active = ${isActive} WHERE id = ${id}::UUID`;
}

export async function deleteCostCentre(id: string): Promise<void> {
  // Check for usage in journal lines
  const usage = (await sql`
    SELECT COUNT(*) as cnt FROM gl_journal_lines WHERE cost_center_id = ${id}::UUID
  `) as Row[];
  if (Number(usage[0]?.cnt) > 0) {
    throw new Error('Cannot delete cost centre that is used in journal entries. Deactivate instead.');
  }
  await sql`DELETE FROM cost_centres WHERE id = ${id}::UUID`;
}

function mapRow(row: Row): CostCentre {
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
