/**
 * Audit Service
 * Admin action logging for ISAFlow Admin Platform
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { AuditLogEntry, PaginatedResult } from '../types/admin.types';

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

export async function logAdminAction(
  adminUserId: string,
  action: string,
  targetType: string,
  targetId: string | null,
  details: Record<string, unknown> | null,
  ipAddress: string | null
): Promise<void> {
  try {
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
  } catch (err) {
    // Audit logging must not break the calling flow — log and swallow
    log.error('logAdminAction failed', { adminUserId, action, error: err }, 'auditService');
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
