/**
 * Audit Trail Service
 * Field-level change history for all accounting entities.
 * logAudit is fire-and-forget — never throws.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'post'
  | 'reverse'
  | 'approve'
  | 'reject'
  | 'login'
  | 'export';

export interface AuditFieldChange {
  field: string;
  old: string | null;
  new: string | null;
  label: string;
}

export interface AuditChanges {
  fields: AuditFieldChange[];
  metadata?: Record<string, string>;
}

export interface AuditLogItem {
  id: string;
  companyId: string;
  userId: string;
  userEmail: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  entityRef: string | null;
  changes: AuditChanges | null;
  ipAddress: string | null;
  userAgent: string | null;
  sessionId: string | null;
  createdAt: string;
}

export interface LogAuditParams {
  companyId: string;
  userId: string;
  userEmail?: string;
  action: AuditAction;
  entityType: string;
  entityId: string;
  entityRef?: string;
  changes?: AuditChanges;
  ip?: string;
  userAgent?: string;
  sessionId?: string;
}

export interface AuditLogFilters {
  entityType?: string;
  entityId?: string;
  userId?: string;
  action?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

/**
 * Fire-and-forget audit log writer. Never throws — errors are swallowed
 * so audit failures never break the calling transaction.
 */
export async function logAudit(params: LogAuditParams): Promise<void> {
  try {
    const changesJson = params.changes ? JSON.stringify(params.changes) : null;
    await sql`
      INSERT INTO audit_log (
        company_id, user_id, user_email, action,
        entity_type, entity_id, entity_ref,
        changes, ip_address, user_agent, session_id
      ) VALUES (
        ${params.companyId}::UUID,
        ${params.userId},
        ${params.userEmail ?? null},
        ${params.action},
        ${params.entityType},
        ${params.entityId}::UUID,
        ${params.entityRef ?? null},
        ${changesJson}::JSONB,
        ${params.ip ?? null},
        ${params.userAgent ?? null},
        ${params.sessionId ? params.sessionId + '::UUID' : null}
      )
    `;
  } catch (err) {
    // Never surface audit errors to callers
    log.warn('Audit log write failed', { error: err, params }, 'audit-trail');
  }
}

export async function getAuditLog(
  companyId: string,
  filters: AuditLogFilters,
): Promise<{ items: AuditLogItem[]; total: number }> {
  try {
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    // Build conditional clauses using separate queries per filter combination
    // to avoid dynamic SQL string concatenation
    const entityType = filters.entityType ?? null;
    const entityId = filters.entityId ?? null;
    const userId = filters.userId ?? null;
    const action = filters.action ?? null;
    const dateFrom = filters.dateFrom ?? null;
    const dateTo = filters.dateTo ?? null;
    const search = filters.search ? `%${filters.search}%` : null;

    const rows = (await sql`
      SELECT *
      FROM audit_log
      WHERE company_id = ${companyId}::UUID
        AND (${entityType}::VARCHAR IS NULL OR entity_type = ${entityType})
        AND (${entityId}::UUID IS NULL OR entity_id = ${entityId}::UUID)
        AND (${userId}::VARCHAR IS NULL OR user_id = ${userId})
        AND (${action}::VARCHAR IS NULL OR action = ${action})
        AND (${dateFrom}::TIMESTAMPTZ IS NULL OR created_at >= ${dateFrom}::TIMESTAMPTZ)
        AND (${dateTo}::TIMESTAMPTZ IS NULL OR created_at <= ${dateTo}::TIMESTAMPTZ)
        AND (
          ${search}::VARCHAR IS NULL
          OR user_email ILIKE ${search}
          OR entity_ref ILIKE ${search}
          OR entity_type ILIKE ${search}
        )
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `) as Row[];

    const countRows = (await sql`
      SELECT COUNT(*) AS cnt
      FROM audit_log
      WHERE company_id = ${companyId}::UUID
        AND (${entityType}::VARCHAR IS NULL OR entity_type = ${entityType})
        AND (${entityId}::UUID IS NULL OR entity_id = ${entityId}::UUID)
        AND (${userId}::VARCHAR IS NULL OR user_id = ${userId})
        AND (${action}::VARCHAR IS NULL OR action = ${action})
        AND (${dateFrom}::TIMESTAMPTZ IS NULL OR created_at >= ${dateFrom}::TIMESTAMPTZ)
        AND (${dateTo}::TIMESTAMPTZ IS NULL OR created_at <= ${dateTo}::TIMESTAMPTZ)
        AND (
          ${search}::VARCHAR IS NULL
          OR user_email ILIKE ${search}
          OR entity_ref ILIKE ${search}
          OR entity_type ILIKE ${search}
        )
    `) as Row[];

    return {
      items: rows.map(mapAuditRow),
      total: Number(countRows[0].cnt),
    };
  } catch (err) {
    log.error('Failed to get audit log', { companyId, filters, error: err }, 'audit-trail');
    throw err;
  }
}

export async function getEntityHistory(
  companyId: string,
  entityType: string,
  entityId: string,
): Promise<AuditLogItem[]> {
  try {
    const rows = (await sql`
      SELECT *
      FROM audit_log
      WHERE company_id = ${companyId}::UUID
        AND entity_type = ${entityType}
        AND entity_id = ${entityId}::UUID
      ORDER BY created_at DESC
    `) as Row[];
    return rows.map(mapAuditRow);
  } catch (err) {
    log.error('Failed to get entity history', { companyId, entityType, entityId, error: err }, 'audit-trail');
    throw err;
  }
}

/**
 * Diffs two objects and returns an array of field changes.
 * Only includes fields that actually changed.
 */
export function diffObjects(
  oldObj: Record<string, unknown>,
  newObj: Record<string, unknown>,
  fieldLabels: Record<string, string>,
): AuditFieldChange[] {
  const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);
  const changes: AuditFieldChange[] = [];

  for (const key of allKeys) {
    const oldVal = oldObj[key];
    const newVal = newObj[key];
    const oldStr = oldVal == null ? null : String(oldVal);
    const newStr = newVal == null ? null : String(newVal);
    if (oldStr !== newStr) {
      changes.push({
        field: key,
        old: oldStr,
        new: newStr,
        label: fieldLabels[key] ?? key,
      });
    }
  }

  return changes;
}

function mapAuditRow(row: Row): AuditLogItem {
  return {
    id: String(row.id),
    companyId: String(row.company_id),
    userId: String(row.user_id),
    userEmail: row.user_email ? String(row.user_email) : null,
    action: String(row.action) as AuditAction,
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    entityRef: row.entity_ref ? String(row.entity_ref) : null,
    changes: row.changes ?? null,
    ipAddress: row.ip_address ? String(row.ip_address) : null,
    userAgent: row.user_agent ? String(row.user_agent) : null,
    sessionId: row.session_id ? String(row.session_id) : null,
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : String(row.created_at),
  };
}
