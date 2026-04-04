/**
 * Business Unit Service
 * CRUD operations for the business_units table
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = Record<string, unknown>;

export interface BusinessUnit {
  id: string;
  code: string;
  name: string;
  description?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BusinessUnitInput {
  code: string;
  name: string;
  description?: string;
}

export async function getBusinessUnits(companyId: string, activeOnly = false): Promise<BusinessUnit[]> {
  const rows = activeOnly
    ? ((await sql`SELECT * FROM business_units WHERE company_id = ${companyId} AND is_active = true ORDER BY code`) as Row[])
    : ((await sql`SELECT * FROM business_units WHERE company_id = ${companyId} ORDER BY code`) as Row[]);
  return rows.map(mapRow);
}

export async function createBusinessUnit(companyId: string, input: BusinessUnitInput, _userId: string): Promise<BusinessUnit> {
  const rows = (await sql`
    INSERT INTO business_units (company_id, code, name, description)
    VALUES (${companyId}, ${input.code}, ${input.name}, ${input.description || null})
    RETURNING *
  `) as Record<string, unknown>[];
  log.info('Created business unit', { id: rows[0]!.id, code: input.code }, 'accounting');
  return mapRow(rows[0]!);
}

export async function updateBusinessUnit(companyId: string, id: string, input: Partial<BusinessUnitInput>): Promise<BusinessUnit> {
  const rows = (await sql`
    UPDATE business_units SET
      code = COALESCE(${input.code || null}, code),
      name = COALESCE(${input.name || null}, name),
      description = COALESCE(${input.description || null}, description),
      updated_at = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId} RETURNING *
  `) as Record<string, unknown>[];
  if (!rows[0]) throw new Error(`Business unit ${id} not found`);
  return mapRow(rows[0]);
}

export async function toggleBusinessUnit(companyId: string, id: string, isActive: boolean): Promise<void> {
  await sql`UPDATE business_units SET is_active = ${isActive}, updated_at = NOW() WHERE id = ${id}::UUID AND company_id = ${companyId}`;
}

export async function deleteBusinessUnit(companyId: string, id: string): Promise<void> {
  const usage = (await sql`
    SELECT COUNT(*) as cnt FROM gl_journal_lines WHERE bu_id = ${id}::UUID
  `) as Record<string, unknown>[];
  if (Number(usage[0]?.cnt) > 0) {
    throw new Error('Cannot delete business unit used in journal entries. Deactivate instead.');
  }
  const btUsage = (await sql`
    SELECT COUNT(*) as cnt FROM bank_transactions WHERE bu_id = ${id}::UUID
  `) as Record<string, unknown>[];
  if (Number(btUsage[0]?.cnt) > 0) {
    throw new Error('Cannot delete business unit used in bank transactions. Deactivate instead.');
  }
  await sql`DELETE FROM business_units WHERE id = ${id}::UUID AND company_id = ${companyId}`;
}

function mapRow(row: Record<string, unknown>): BusinessUnit {
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    description: row.description ? String(row.description) : undefined,
    isActive: Boolean(row.is_active),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
