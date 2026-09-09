/**
 * Audit Service
 * Admin action logging for ISAFlow Admin Platform.
 * Read/query functions live in auditQueryService.ts.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { als } from '@/lib/als';
import { log } from '@/lib/logger';
import type { AuditLogEntry, PaginatedResult } from '../types/admin.types';

/**
 * Thrown by logAdminAction when an audit write fails for any action outside
 * BEST_EFFORT_ACTIONS. A distinct type so callers/middleware can tell "the audit failed" apart from
 * "the mutation failed" and refuse to let the privileged action persist
 * unaudited. (Pentest M6.)
 */
export class CriticalAuditError extends Error {
  constructor(action: string) {
    super(`Audit logging failed for critical action: ${action}`);
    this.name = 'CriticalAuditError';
  }
}

// Re-export read functions for backward compatibility
export type { UnifiedAuditEntry, UnifiedAuditFilters } from './auditQueryService';
export { getUnifiedAuditLog } from './auditQueryService';

export interface AuditLogFilters {
  admin_user_id?: string;
  target_type?: string;
  target_id?: string;
  action?: string;
  from_date?: string;
  to_date?: string;
  page?: number;
  limit?: number;
}

/**
 * Actions whose audit write may fail WITHOUT failing the request.
 *
 * Everything else fails closed: `logAdminAction` throws CriticalAuditError and
 * flags the request context so withPlatformAdmin/withAdmin roll the whole
 * transaction back. Guarded by tests/unit/services/adminCriticalActions.test.ts.
 *
 * It used to be the other way round — an allow-list named CRITICAL_ACTIONS, with
 * everything outside it best-effort. That was safe only while a failed INSERT
 * poisoned the request transaction and took the mutation down with it. Once the
 * INSERT got its own savepoint (below), non-membership stopped meaning
 * "discarded" and started meaning "commits unaudited behind a 2xx" — and the
 * list was, predictably, incomplete: `flow.bundle.update` reprices every
 * tenant's wallet bundles, `user.add_to_company` grants access to a tenant's
 * books, `trial.extend` grants free paid service, and none of the three were on
 * it. An allow-list of privileged actions has to be complete to be correct; a
 * deny-list of harmless ones only has to be right about the entries it names.
 *
 * Every entry has to be a string some `logAdminAction` call site actually
 * passes. Actions written by a direct INSERT INTO admin_audit_log never reach
 * this function and are not governed by it — those routes protect themselves.
 *
 * Empty on purpose: every action emitted today mutates platform or tenant
 * state. Add one only with a reason why an unaudited commit of it is
 * acceptable.
 */
export const BEST_EFFORT_ACTIONS = new Set<string>([]);

export async function logAdminAction(
  adminUserId: string,
  action: string,
  targetType: string,
  targetId: string | null,
  details: Record<string, unknown> | null,
  ipAddress: string | null
): Promise<void> {
  try {
    // The audit write shares the request transaction withPlatformAdmin /
    // withAdmin opened, so it needs its own savepoint. Without one, a
    // failed INSERT aborts that transaction, Postgres answers the middleware's
    // COMMIT with a silent ROLLBACK, and the admin mutation this log entry
    // describes disappears behind a 2xx. The catch below then decides whether
    // the request itself may survive an unlogged mutation.
    await withSavepoint('admin_audit_log_write', async () => {
      await sql`
        INSERT INTO admin_audit_log (
          admin_user_id,
          action,
          target_type,
          target_id,
          details,
          ip_address,
          created_at
        ) VALUES (
          ${adminUserId},
          ${action},
          ${targetType},
          ${targetId},
          ${details ? JSON.stringify(details) : null},
          ${ipAddress},
          NOW()
        )
      `;
    });
  } catch (err) {
    log.error('logAdminAction failed', { adminUserId, action, error: err }, 'auditService');
    if (BEST_EFFORT_ACTIONS.has(action)) return;
    // M6: flag the request context so withPlatformAdmin ROLLS BACK the whole
    // transaction even if a route-level catch swallows the throw below — a
    // privileged action must never COMMIT without its audit row.
    const ctx = als.getStore();
    if (ctx) ctx.criticalAuditFailed = true;
    throw new CriticalAuditError(action);
  }
}

export async function getAuditLog(
  filters: AuditLogFilters = {}
): Promise<PaginatedResult<AuditLogEntry>> {
  const page = Math.max(1, filters.page ?? 1);
  const limit = Math.min(100, Math.max(1, filters.limit ?? 25));
  const offset = (page - 1) * limit;

  try {
    const rows = await sql`
      SELECT
        al.id,
        al.admin_user_id,
        COALESCE(u.first_name || ' ' || u.last_name, u.email, 'Unknown') AS admin_name,
        al.action,
        al.target_type,
        al.target_id,
        al.details,
        al.ip_address,
        al.created_at
      FROM admin_audit_log al
      LEFT JOIN users u ON u.id = al.admin_user_id::text
      WHERE (
        ${filters.admin_user_id ? sql`al.admin_user_id = ${filters.admin_user_id}` : sql`TRUE`}
      )
      AND (${filters.target_type ? sql`al.target_type = ${filters.target_type}` : sql`TRUE`})
      AND (${filters.target_id ? sql`al.target_id = ${filters.target_id}` : sql`TRUE`})
      AND (${filters.action ? sql`al.action ILIKE ${'%' + filters.action + '%'}` : sql`TRUE`})
      AND (${filters.from_date ? sql`al.created_at >= ${filters.from_date}::timestamptz` : sql`TRUE`})
      AND (${filters.to_date ? sql`al.created_at <= ${filters.to_date}::timestamptz` : sql`TRUE`})
      ORDER BY al.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const [countRow] = await sql`
      SELECT COUNT(*)::int AS total
      FROM admin_audit_log al
      WHERE (
        ${filters.admin_user_id ? sql`al.admin_user_id = ${filters.admin_user_id}` : sql`TRUE`}
      )
      AND (${filters.target_type ? sql`al.target_type = ${filters.target_type}` : sql`TRUE`})
      AND (${filters.target_id ? sql`al.target_id = ${filters.target_id}` : sql`TRUE`})
      AND (${filters.action ? sql`al.action ILIKE ${'%' + filters.action + '%'}` : sql`TRUE`})
      AND (${filters.from_date ? sql`al.created_at >= ${filters.from_date}::timestamptz` : sql`TRUE`})
      AND (${filters.to_date ? sql`al.created_at <= ${filters.to_date}::timestamptz` : sql`TRUE`})
    `;

    const toIso = (v: unknown) =>
      v instanceof Date ? v.toISOString() : (v as string);

    const total = countRow?.total ?? 0;

    return {
      items: rows.map((r) => ({
        id: r.id as string,
        admin_user_id: r.admin_user_id as string,
        admin_name: r.admin_name as string,
        action: r.action as string,
        target_type: r.target_type as string,
        target_id: r.target_id as string | null,
        details: (r.details ?? {}) as Record<string, unknown>,
        ip_address: r.ip_address as string | null,
        created_at: toIso(r.created_at),
      })),
      total,
      page,
      limit,
      total_pages: Math.ceil(total / limit),
    };
  } catch (err) {
    log.error('getAuditLog failed', { error: err }, 'auditService');
    throw err;
  }
}
