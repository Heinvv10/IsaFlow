/**
 * Admin User Service
 * Cross-company user management for the ISAFlow Admin Platform.
 * All mutations should be followed by logAdminAction from auditService.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { generateRandomPassword, hashPassword } from '@/lib/auth';
import type {
  AdminUserListItem,
  AdminUserDetail,
  AdminUserCompany,
  AdminListFilters,
  PaginatedResult,
} from '../types/admin.types';

type Row = Record<string, unknown>;

function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return value as string;
}

const ALLOWED_SORT_COLUMNS: Record<string, string> = {
  email: 'u.email',
  first_name: 'u.first_name',
  last_name: 'u.last_name',
  created_at: 'u.created_at',
  last_login: 'u.last_login',
  role: 'u.role',
};

export async function listUsers(
  filters: AdminListFilters & { role?: string; company_id?: string } = {}
): Promise<PaginatedResult<AdminUserListItem>> {
  const page = Math.max(1, filters.page ?? 1);
  const limit = Math.min(100, Math.max(1, filters.limit ?? 25));
  const offset = (page - 1) * limit;
  const sortCol = ALLOWED_SORT_COLUMNS[filters.sort_by ?? ''] ?? 'u.created_at';
  const sortDir = filters.sort_dir === 'asc' ? sql`ASC` : sql`DESC`;

  const searchPattern = filters.search ? `%${filters.search}%` : null;

  const [countRow] = await sql`
    SELECT COUNT(DISTINCT u.id) AS total
    FROM users u
    LEFT JOIN company_users cu ON cu.user_id = u.id
    WHERE (${searchPattern}::text IS NULL
           OR u.email ILIKE ${searchPattern}
           OR u.first_name ILIKE ${searchPattern}
           OR u.last_name ILIKE ${searchPattern})
      AND (${filters.role ?? null}::text IS NULL OR u.role = ${filters.role ?? null})
      AND (${filters.company_id ?? null}::uuid IS NULL OR cu.company_id = ${filters.company_id ?? null}::uuid)
      AND (${filters.status ?? null}::text IS NULL
           OR (${filters.status ?? null} = 'active'    AND u.is_active = true)
           OR (${filters.status ?? null} = 'suspended' AND u.is_active = false))
  `;

  const rows = await sql`
    SELECT
      u.id,
      u.email,
      u.first_name,
      u.last_name,
      u.role,
      CASE WHEN u.is_active THEN 'active' ELSE 'suspended' END        AS status,
      (SELECT COUNT(*)
         FROM company_users cu2
        WHERE cu2.user_id = u.id)::int                                AS company_count,
      ARRAY(
        SELECT c.name
          FROM company_users cu3
          JOIN companies c ON c.id = cu3.company_id
         WHERE cu3.user_id = u.id
         ORDER BY c.name
         LIMIT 10
      )                                                               AS company_names,
      u.last_login,
      COALESCE(
        (SELECT COUNT(*) FROM user_sessions s WHERE s.user_id = u.id)::int,
        0
      )                                                               AS login_count,
      u.created_at
    FROM users u
    LEFT JOIN company_users cu ON cu.user_id = u.id
    WHERE (${searchPattern}::text IS NULL
           OR u.email ILIKE ${searchPattern}
           OR u.first_name ILIKE ${searchPattern}
           OR u.last_name ILIKE ${searchPattern})
      AND (${filters.role ?? null}::text IS NULL OR u.role = ${filters.role ?? null})
      AND (${filters.company_id ?? null}::uuid IS NULL OR cu.company_id = ${filters.company_id ?? null}::uuid)
      AND (${filters.status ?? null}::text IS NULL
           OR (${filters.status ?? null} = 'active'    AND u.is_active = true)
           OR (${filters.status ?? null} = 'suspended' AND u.is_active = false))
    GROUP BY u.id, u.email, u.first_name, u.last_name, u.role, u.is_active,
             u.last_login, u.created_at
    ORDER BY ${sql.unsafe(sortCol)} ${sortDir}
    LIMIT ${limit} OFFSET ${offset}
  `;

  const total = parseInt((countRow as Row).total as string, 10);

  log.info(`listUsers: ${rows.length} rows (page ${page}, total ${total})`, {}, 'AdminUserService');

  return {
    items: (rows as Row[]).map((r) => ({
      id: r.id as string,
      email: r.email as string,
      first_name: r.first_name as string | null,
      last_name: r.last_name as string | null,
      role: r.role as string,
      status: r.status as string,
      company_count: r.company_count as number,
      company_names: (r.company_names as string[]) ?? [],
      last_login: toIso(r.last_login),
      login_count: r.login_count as number,
      created_at: toIso(r.created_at) ?? '',
    })),
    total,
    page,
    limit,
    total_pages: Math.ceil(total / limit),
  };
}

export async function getUserDetail(
  userId: string
): Promise<AdminUserDetail | null> {
  const rows = await sql`
    SELECT
      u.id,
      u.email,
      u.first_name,
      u.last_name,
      u.role,
      CASE WHEN u.is_active THEN 'active' ELSE 'suspended' END AS status,
      u.phone,
      u.department,
      u.last_login,
      u.last_login_ip,
      u.suspended_at,
      u.suspended_reason,
      COALESCE(
        (SELECT COUNT(*) FROM user_sessions s WHERE s.user_id = u.id)::int,
        0
      ) AS login_count,
      u.created_at
    FROM users u
    WHERE u.id = ${userId}
    LIMIT 1
  `;

  if (rows.length === 0) return null;
  const r = rows[0] as Row;

  const companyRows = await sql`
    SELECT
      cu.company_id,
      c.name AS company_name,
      cu.role,
      COALESCE(cu.is_default, false) AS is_default
    FROM company_users cu
    JOIN companies c ON c.id = cu.company_id
    WHERE cu.user_id = ${userId}
    ORDER BY c.name
  `;

  const companies: AdminUserCompany[] = (companyRows as Row[]).map((c) => ({
    company_id: c.company_id as string,
    company_name: c.company_name as string,
    role: c.role as string,
    is_default: c.is_default as boolean,
  }));

  return {
    id: r.id as string,
    email: r.email as string,
    first_name: r.first_name as string | null,
    last_name: r.last_name as string | null,
    role: r.role as string,
    status: r.status as string,
    company_count: companies.length,
    company_names: companies.map((c) => c.company_name),
    last_login: toIso(r.last_login),
    login_count: r.login_count as number,
    created_at: toIso(r.created_at) ?? '',
    phone: r.phone as string | null,
    department: r.department as string | null,
    last_login_ip: r.last_login_ip as string | null,
    suspended_at: toIso(r.suspended_at),
    suspended_reason: r.suspended_reason as string | null,
    companies,
  };
}

export async function updateUser(
  userId: string,
  data: { first_name?: string; last_name?: string; role?: string; phone?: string }
): Promise<void> {
  await sql`
    UPDATE users SET
      first_name = COALESCE(${data.first_name ?? null}, first_name),
      last_name  = COALESCE(${data.last_name ?? null}, last_name),
      role       = COALESCE(${data.role ?? null}, role),
      phone      = COALESCE(${data.phone ?? null}, phone),
      updated_at = NOW()
    WHERE id = ${userId}
  `;
  log.info('updateUser', { userId }, 'AdminUserService');
}

export async function suspendUser(
  userId: string,
  reason: string
): Promise<void> {
  await sql`
    UPDATE users
    SET is_active        = false,
        suspended_reason = ${reason},
        suspended_at     = NOW(),
        updated_at       = NOW()
    WHERE id = ${userId}
  `;
  // Invalidate all active sessions immediately
  await sql`DELETE FROM user_sessions WHERE user_id = ${userId}`;
  log.info('suspendUser', { userId, reason }, 'AdminUserService');
}

export async function activateUser(userId: string): Promise<void> {
  await sql`
    UPDATE users
    SET is_active        = true,
        suspended_reason = NULL,
        suspended_at     = NULL,
        updated_at       = NOW()
    WHERE id = ${userId}
  `;
  log.info('activateUser', { userId }, 'AdminUserService');
}

/**
 * Generate a temporary password, hash and store it, return plain text.
 * Caller is responsible for emailing the reset token/password.
 */
export async function resetPassword(userId: string): Promise<string> {
  const temporaryPassword = generateRandomPassword();
  const hashed = await hashPassword(temporaryPassword);

  await sql`
    UPDATE users
    SET password_hash        = ${hashed},
        must_change_password = true,
        updated_at           = NOW()
    WHERE id = ${userId}
  `;

  log.info('resetPassword — temporary password issued', { userId }, 'AdminUserService');
  return temporaryPassword;
}

/**
 * Force logout by deleting all active sessions for a user.
 * A no-op placeholder message is logged if no sessions exist.
 */
export async function forceLogout(userId: string): Promise<void> {
  await sql`DELETE FROM user_sessions WHERE user_id = ${userId}`;
  log.info('forceLogout — sessions cleared', { userId }, 'AdminUserService');
}

export async function addUserToCompany(
  userId: string,
  companyId: string,
  role: string
): Promise<void> {
  await sql`
    INSERT INTO company_users (user_id, company_id, role, created_at)
    VALUES (${userId}, ${companyId}, ${role}, NOW())
    ON CONFLICT (user_id, company_id) DO UPDATE
      SET role       = EXCLUDED.role,
          updated_at = NOW()
  `;
  log.info('addUserToCompany', { userId, companyId, role }, 'AdminUserService');
}

export async function removeUserFromCompany(
  userId: string,
  companyId: string
): Promise<void> {
  await sql`
    DELETE FROM company_users
    WHERE user_id = ${userId} AND company_id = ${companyId}
  `;
  log.info('removeUserFromCompany', { userId, companyId }, 'AdminUserService');
}
