/**
 * UDF Service — User Defined Fields
 * Manages field definitions (per entity type) and their values (per entity record).
 * All queries are scoped by company_id (multi-tenant safe).
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// ── Types ────────────────────────────────────────────────────────────────────

export type UdfEntityType = 'customer' | 'supplier' | 'invoice' | 'item';
export type UdfFieldType = 'text' | 'number' | 'date' | 'boolean' | 'select';

export interface UdfDefinition {
  id: string;
  companyId: string;
  entityType: UdfEntityType;
  fieldNumber: number;
  fieldLabel: string;
  fieldType: UdfFieldType;
  fieldOptions: string | null;
  isRequired: boolean;
  isActive: boolean;
  createdAt: string;
}

export interface UdfDefinitionInput {
  entityType: UdfEntityType;
  fieldNumber: number;
  fieldLabel: string;
  fieldType: UdfFieldType;
  fieldOptions?: string | null;
  isRequired?: boolean;
  isActive?: boolean;
}

// ── Mappers ──────────────────────────────────────────────────────────────────

function mapRow(row: Record<string, unknown>): UdfDefinition {
  return {
    id: row.id as string,
    companyId: row.company_id as string,
    entityType: row.entity_type as UdfEntityType,
    fieldNumber: row.field_number as number,
    fieldLabel: row.field_label as string,
    fieldType: row.field_type as UdfFieldType,
    fieldOptions: (row.field_options as string | null) ?? null,
    isRequired: row.is_required as boolean,
    isActive: row.is_active as boolean,
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : (row.created_at as string),
  };
}

// ── Definitions ───────────────────────────────────────────────────────────────

export async function getUdfDefinitions(
  companyId: string,
  entityType: UdfEntityType,
): Promise<UdfDefinition[]> {
  const rows = await sql`
    SELECT * FROM company_udf_definitions
    WHERE company_id = ${companyId}::UUID
      AND entity_type = ${entityType}
    ORDER BY field_number ASC
  ` as Record<string, unknown>[];

  log.info('udfService.getUdfDefinitions', { companyId, entityType, count: rows.length });
  return rows.map(mapRow);
}

export async function upsertUdfDefinition(
  companyId: string,
  input: UdfDefinitionInput,
): Promise<UdfDefinition> {
  const {
    entityType,
    fieldNumber,
    fieldLabel,
    fieldType,
    fieldOptions = null,
    isRequired = false,
    isActive = true,
  } = input;

  if (fieldNumber < 1 || fieldNumber > 12) {
    throw new Error('field_number must be between 1 and 12');
  }

  const rows = await sql`
    INSERT INTO company_udf_definitions
      (company_id, entity_type, field_number, field_label, field_type, field_options, is_required, is_active)
    VALUES
      (${companyId}::UUID, ${entityType}, ${fieldNumber}, ${fieldLabel}, ${fieldType}, ${fieldOptions}, ${isRequired}, ${isActive})
    ON CONFLICT (company_id, entity_type, field_number)
    DO UPDATE SET
      field_label  = EXCLUDED.field_label,
      field_type   = EXCLUDED.field_type,
      field_options = EXCLUDED.field_options,
      is_required  = EXCLUDED.is_required,
      is_active    = EXCLUDED.is_active
    RETURNING *
  ` as Record<string, unknown>[];

  log.info('udfService.upsertUdfDefinition', { companyId, entityType, fieldNumber });
  if (!rows[0]) throw new Error('Upsert returned no rows');
  return mapRow(rows[0]);
}

// ── Values ───────────────────────────────────────────────────────────────────

/**
 * Returns a map of field_number -> value for a specific entity record.
 */
export async function getEntityUdfValues(
  companyId: string,
  entityType: UdfEntityType,
  entityId: string,
): Promise<Record<number, string>> {
  const rows = await sql`
    SELECT field_number, value FROM entity_udf_values
    WHERE company_id  = ${companyId}::UUID
      AND entity_type = ${entityType}
      AND entity_id   = ${entityId}::UUID
  ` as Record<string, unknown>[];

  const result: Record<number, string> = {};
  for (const row of rows) {
    result[row.field_number as number] = (row.value as string) ?? '';
  }
  return result;
}

/**
 * Upserts multiple UDF values for one entity record.
 * Only persists entries where value is non-empty.
 */
export async function setEntityUdfValues(
  companyId: string,
  entityType: UdfEntityType,
  entityId: string,
  values: Record<number, string>,
): Promise<void> {
  const entries = Object.entries(values).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;

  for (const [fieldNumStr, value] of entries) {
    const fieldNumber = Number(fieldNumStr);
    await sql`
      INSERT INTO entity_udf_values
        (company_id, entity_type, entity_id, field_number, value, updated_at)
      VALUES
        (${companyId}::UUID, ${entityType}, ${entityId}::UUID, ${fieldNumber}, ${value}, NOW())
      ON CONFLICT (company_id, entity_type, entity_id, field_number)
      DO UPDATE SET
        value      = EXCLUDED.value,
        updated_at = NOW()
    `;
  }

  log.info('udfService.setEntityUdfValues', { companyId, entityType, entityId, count: entries.length });
}
