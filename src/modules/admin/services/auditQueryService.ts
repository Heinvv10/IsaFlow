/**
 * Audit Query Service
 * Read/filter/export functions for the unified audit log.
 * Write functions (logAdminAction, getAuditLog) remain in auditService.ts.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { PaginatedResult } from '../types/admin.types';

export interface UnifiedAuditEntry {
  id: string;
  source: 'admin' | 'accounting' | 'auth';
  user_id: string | null;
  user_name: string | null;
  user_email: string | null;
  company_id: string | null;
  company_name: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  entity_ref: string | null;
  details: Record<string, unknown> | string | null;
  ip_address: string | null;
  created_at: string;
}

export interface UnifiedAuditFilters {
  source?: 'admin' | 'accounting' | 'auth';
  company_id?: string;
  user_id?: string;
  action?: string;
  entity_type?: string;
  search?: string;
  from_date?: string;
  to_date?: string;
  page?: number;
  limit?: number;
}

function toIsoDate(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return v as string;
}

export async function getUnifiedAuditLog(
  filters: UnifiedAuditFilters = {}
): Promise<PaginatedResult<UnifiedAuditEntry>> {
  const page  = Math.max(1, filters.page  ?? 1);
  const limit = Math.min(100, Math.max(1, filters.limit ?? 50));
  const offset = (page - 1) * limit;

  const includeAdmin      = !filters.source || filters.source === 'admin';
  const includeAccounting = !filters.source || filters.source === 'accounting';
  const includeAuth       = !filters.source || filters.source === 'auth';

  const fromDate   = filters.from_date ?? null;
  const toDate     = filters.to_date   ?? null;
  const searchTerm = filters.search    ? `%${filters.search}%` : null;
  const filterAction     = filters.action      ?? null;
  const filterEntityType = filters.entity_type ?? null;
  const filterCompanyId  = filters.company_id  ?? null;
  const filterUserId     = filters.user_id     ?? null;

  try {
    const rows = await sql`
      WITH admin_rows AS (
        SELECT
          'admin-' || al.id::text                    AS id,
          'admin'::text                              AS source,
          al.admin_user_id::text                     AS user_id,
          COALESCE(u.first_name || ' ' || u.last_name, u.email, 'Admin') AS user_name,
          u.email                                    AS user_email,
          NULL::uuid                                 AS company_id,
          NULL::text                                 AS company_name,
          al.action                                  AS action,
          al.target_type                             AS entity_type,
          al.target_id::text                         AS entity_id,
          NULL::text                                 AS entity_ref,
          al.details::text                           AS details_text,
          al.ip_address                              AS ip_address,
          al.created_at                              AS created_at
        FROM admin_audit_log al
        LEFT JOIN users u ON u.id::text = al.admin_user_id::text
        WHERE ${includeAdmin ? sql`TRUE` : sql`FALSE`}
          AND (${filterCompanyId ? sql`FALSE` : sql`TRUE`})
          AND (${filterUserId    ? sql`al.admin_user_id::text = ${filterUserId}` : sql`TRUE`})
      ),
      accounting_rows AS (
        SELECT
          'acct-' || al.id::text                     AS id,
          'accounting'::text                         AS source,
          al.user_id::text                           AS user_id,
          COALESCE(u.first_name || ' ' || u.last_name, al.user_email, 'User') AS user_name,
          COALESCE(al.user_email, u.email)           AS user_email,
          al.company_id                              AS company_id,
          c.name                                     AS company_name,
          al.action                                  AS action,
          al.entity_type                             AS entity_type,
          al.entity_id::text                         AS entity_id,
          al.entity_ref                              AS entity_ref,
          al.changes::text                           AS details_text,
          al.ip_address                              AS ip_address,
          al.created_at                              AS created_at
        FROM audit_log al
        LEFT JOIN users u ON u.id = al.user_id
        LEFT JOIN companies c ON c.id = al.company_id
        WHERE ${includeAccounting ? sql`TRUE` : sql`FALSE`}
          AND (${filterCompanyId ? sql`al.company_id = ${filterCompanyId}::uuid` : sql`TRUE`})
          AND (${filterUserId    ? sql`al.user_id::text = ${filterUserId}` : sql`TRUE`})
          AND (${filterEntityType ? sql`al.entity_type ILIKE ${filterEntityType}` : sql`TRUE`})
      ),
      auth_rows AS (
        SELECT
          'auth-' || us.id::text                     AS id,
          'auth'::text                               AS source,
          us.user_id::text                           AS user_id,
          COALESCE(u.first_name || ' ' || u.last_name, u.email, 'User') AS user_name,
          u.email                                    AS user_email,
          NULL::uuid                                 AS company_id,
          NULL::text                                 AS company_name,
          'login'::text                              AS action,
          'session'::text                            AS entity_type,
          us.id::text                                AS entity_id,
          NULL::text                                 AS entity_ref,
          NULL::text                                 AS details_text,
          us.ip_address                              AS ip_address,
          us.created_at                              AS created_at
        FROM user_sessions us
        LEFT JOIN users u ON u.id = us.user_id
        WHERE ${includeAuth ? sql`TRUE` : sql`FALSE`}
          AND (${filterCompanyId ? sql`FALSE` : sql`TRUE`})
          AND (${filterUserId    ? sql`us.user_id::text = ${filterUserId}` : sql`TRUE`})
          AND (${filterEntityType ? sql`'session' ILIKE ${filterEntityType}` : sql`TRUE`})
      ),
      combined AS (
        SELECT * FROM admin_rows
        UNION ALL
        SELECT * FROM accounting_rows
        UNION ALL
        SELECT * FROM auth_rows
      )
      SELECT *
      FROM combined
      WHERE (${fromDate   ? sql`created_at >= ${fromDate}::timestamptz`   : sql`TRUE`})
        AND (${toDate     ? sql`created_at <= ${toDate}::timestamptz`     : sql`TRUE`})
        AND (${filterAction ? sql`action ILIKE ${'%' + filterAction + '%'}` : sql`TRUE`})
        AND (${searchTerm
          ? sql`(user_email ILIKE ${searchTerm} OR entity_ref ILIKE ${searchTerm} OR action ILIKE ${searchTerm})`
          : sql`TRUE`})
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const [countRow] = await sql`
      WITH admin_rows AS (
        SELECT al.admin_user_id::text AS user_id, NULL::uuid AS company_id,
               al.action, NULL::text AS entity_type, NULL::text AS user_email,
               NULL::text AS entity_ref, al.created_at
        FROM admin_audit_log al
        WHERE ${includeAdmin ? sql`TRUE` : sql`FALSE`}
          AND (${filterCompanyId ? sql`FALSE` : sql`TRUE`})
          AND (${filterUserId ? sql`al.admin_user_id::text = ${filterUserId}` : sql`TRUE`})
      ),
      accounting_rows AS (
        SELECT al.user_id::text, al.company_id, al.action, al.entity_type,
               al.user_email, al.entity_ref, al.created_at
        FROM audit_log al
        WHERE ${includeAccounting ? sql`TRUE` : sql`FALSE`}
          AND (${filterCompanyId ? sql`al.company_id = ${filterCompanyId}::uuid` : sql`TRUE`})
          AND (${filterUserId    ? sql`al.user_id::text = ${filterUserId}` : sql`TRUE`})
          AND (${filterEntityType ? sql`al.entity_type ILIKE ${filterEntityType}` : sql`TRUE`})
      ),
      auth_rows AS (
        SELECT us.user_id::text, NULL::uuid AS company_id, 'login'::text AS action,
               'session'::text AS entity_type, u.email AS user_email,
               NULL::text AS entity_ref, us.created_at
        FROM user_sessions us
        LEFT JOIN users u ON u.id = us.user_id
        WHERE ${includeAuth ? sql`TRUE` : sql`FALSE`}
          AND (${filterCompanyId ? sql`FALSE` : sql`TRUE`})
          AND (${filterUserId    ? sql`us.user_id::text = ${filterUserId}` : sql`TRUE`})
          AND (${filterEntityType ? sql`'session' ILIKE ${filterEntityType}` : sql`TRUE`})
      ),
      combined AS (
        SELECT * FROM admin_rows
        UNION ALL
        SELECT * FROM accounting_rows
        UNION ALL
        SELECT * FROM auth_rows
      )
      SELECT COUNT(*)::int AS total
      FROM combined
      WHERE (${fromDate   ? sql`created_at >= ${fromDate}::timestamptz`   : sql`TRUE`})
        AND (${toDate     ? sql`created_at <= ${toDate}::timestamptz`     : sql`TRUE`})
        AND (${filterAction ? sql`action ILIKE ${'%' + filterAction + '%'}` : sql`TRUE`})
        AND (${searchTerm
          ? sql`(user_email ILIKE ${searchTerm} OR entity_ref ILIKE ${searchTerm} OR action ILIKE ${searchTerm})`
          : sql`TRUE`})
    `;

    const total = countRow?.total ?? 0;

    return {
      items: rows.map((r) => {
        let details: Record<string, unknown> | string | null = null;
        if (r.details_text) {
          try {
            details = JSON.parse(r.details_text as string) as Record<string, unknown>;
          } catch {
            details = r.details_text as string;
          }
        }
        return {
          id:           r.id           as string,
          source:       r.source       as 'admin' | 'accounting' | 'auth',
          user_id:      r.user_id      as string | null,
          user_name:    r.user_name    as string | null,
          user_email:   r.user_email   as string | null,
          company_id:   r.company_id   as string | null,
          company_name: r.company_name as string | null,
          action:       r.action       as string,
          entity_type:  r.entity_type  as string | null,
          entity_id:    r.entity_id    as string | null,
          entity_ref:   r.entity_ref   as string | null,
          details,
          ip_address:   r.ip_address   as string | null,
          created_at:   toIsoDate(r.created_at),
        };
      }),
      total,
      page,
      limit,
      total_pages: Math.ceil(total / limit),
    };
  } catch (err) {
    log.error('getUnifiedAuditLog failed', { error: err }, 'auditQueryService');
    throw err;
  }
}
