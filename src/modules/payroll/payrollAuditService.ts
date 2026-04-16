/**
 * Payroll Audit Service
 * Writes chronological audit entries for every mutation to employees,
 * pay_structures, and payroll_runs. Read API exposed for the audit-log UI.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

export type AuditEntityType = 'employee' | 'pay_structure' | 'payroll_run';
export type AuditAction = 'create' | 'update' | 'delete' | 'complete' | 'reverse';

export interface AuditWriteInput {
  companyId: string;
  entityType: AuditEntityType;
  entityId: string;
  action: AuditAction;
  changedBy: string | null;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  notes?: string;
}

export interface AuditEntry {
  id: string;
  entityType: AuditEntityType;
  entityId: string;
  action: AuditAction;
  changedBy: string | null;
  changedAt: string;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  notes: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export async function writeAuditEntry(input: AuditWriteInput): Promise<void> {
  try {
    await sql`
      INSERT INTO payroll_audit_log (
        company_id, entity_type, entity_id, action, changed_by,
        old_values, new_values, notes
      ) VALUES (
        ${input.companyId}::UUID,
        ${input.entityType},
        ${input.entityId}::UUID,
        ${input.action},
        ${input.changedBy},
        ${input.oldValues ? JSON.stringify(input.oldValues) : null}::JSONB,
        ${input.newValues ? JSON.stringify(input.newValues) : null}::JSONB,
        ${input.notes || null}
      )
    `;
  } catch (err) {
    // Audit logging MUST NOT throw and block the primary operation — just log.
    log.error('writeAuditEntry failed', { input, error: err }, 'payroll-audit');
  }
}

export async function listAuditEntries(
  companyId: string,
  filters: { entityType?: AuditEntityType; entityId?: string; limit?: number }
): Promise<AuditEntry[]> {
  const limit = Math.min(filters.limit || 200, 500);
  try {
    let rows: Row[];
    if (filters.entityType && filters.entityId) {
      rows = (await sql`
        SELECT * FROM payroll_audit_log
        WHERE company_id = ${companyId}::UUID
          AND entity_type = ${filters.entityType}
          AND entity_id = ${filters.entityId}::UUID
        ORDER BY changed_at DESC
        LIMIT ${limit}
      `) as Row[];
    } else if (filters.entityType) {
      rows = (await sql`
        SELECT * FROM payroll_audit_log
        WHERE company_id = ${companyId}::UUID
          AND entity_type = ${filters.entityType}
        ORDER BY changed_at DESC
        LIMIT ${limit}
      `) as Row[];
    } else {
      rows = (await sql`
        SELECT * FROM payroll_audit_log
        WHERE company_id = ${companyId}::UUID
        ORDER BY changed_at DESC
        LIMIT ${limit}
      `) as Row[];
    }

    return rows.map((r) => ({
      id: String(r.id),
      entityType: String(r.entity_type) as AuditEntityType,
      entityId: String(r.entity_id),
      action: String(r.action) as AuditAction,
      changedBy: r.changed_by ? String(r.changed_by) : null,
      changedAt: String(r.changed_at),
      oldValues: r.old_values as Record<string, unknown> | null,
      newValues: r.new_values as Record<string, unknown> | null,
      notes: r.notes ? String(r.notes) : null,
    }));
  } catch (err) {
    log.error('listAuditEntries failed', { error: err }, 'payroll-audit');
    throw err;
  }
}

/**
 * Pure helper — computes the subset of fields that changed between two objects.
 * Returns {old: {...changed}, new: {...changed}} for storage in audit log.
 */
export function diffValues(
  oldV: Record<string, unknown>,
  newV: Record<string, unknown>
): { old: Record<string, unknown>; new: Record<string, unknown> } {
  const out = { old: {} as Record<string, unknown>, new: {} as Record<string, unknown> };
  const keys = new Set([...Object.keys(oldV), ...Object.keys(newV)]);
  for (const k of keys) {
    if (oldV[k] !== newV[k]) {
      out.old[k] = oldV[k];
      out.new[k] = newV[k];
    }
  }
  return out;
}
