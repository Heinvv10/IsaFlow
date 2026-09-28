import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';

export interface CompanyUserSummary {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string; // "First Last" if both set, else email
  companyRole: string; // from company_users.role
}

function mapUser(r: DbRow): CompanyUserSummary {
  const first = r.first_name ? String(r.first_name).trim() : '';
  const last = r.last_name ? String(r.last_name).trim() : '';
  const full = [first, last].filter(Boolean).join(' ').trim();
  return {
    id: String(r.id),
    email: String(r.email),
    firstName: first || null,
    lastName: last || null,
    displayName: full || String(r.email),
    companyRole: String(r.company_role),
  };
}

/**
 * Request-scoped (withAuth / app_user). Reads through company_member_directory
 * (mig 716): a plain JOIN on `users` lists each viewer only themselves under
 * `users_self_read` (R-152). Owner/admin get every member, lower roles only
 * their own row, exactly as company_users RLS allows.
 */
export async function listCompanyUsers(companyId: string): Promise<CompanyUserSummary[]> {
  log.info('listCompanyUsers', { companyId }, 'practice-users');
  const rows = await sql`
    SELECT m.user_id AS id, m.email, m.first_name, m.last_name, m.role AS company_role
    FROM company_member_directory(${companyId}::UUID) m
    WHERE m.is_active = true
    ORDER BY COALESCE(NULLIF(TRIM(m.first_name || ' ' || m.last_name), ''), m.email) ASC
  `;
  return rows.map(mapUser);
}

/**
 * System jobs only (the practice crons: no withAuth, no principal). They run
 * on the pool's own role, which reads past RLS; company_member_directory
 * would refuse them (no auth.uid()). Never call this from a request path.
 */
export async function listCompanyUsersForSystem(companyId: string): Promise<CompanyUserSummary[]> {
  log.info('listCompanyUsersForSystem', { companyId }, 'practice-users');
  const rows = await sql`
    SELECT u.id, u.email, u.first_name, u.last_name, cu.role AS company_role
    FROM users u
    JOIN company_users cu ON cu.user_id::TEXT = u.id
    WHERE cu.company_id = ${companyId}::UUID
      AND u.is_active = true
    ORDER BY COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) ASC
  `;
  return rows.map(mapUser);
}

export async function getCompanyUser(
  companyId: string,
  userId: string,
): Promise<CompanyUserSummary | null> {
  log.info('getCompanyUser', { companyId, userId }, 'practice-users');
  const rows = await sql`
    SELECT u.id, u.email, u.first_name, u.last_name, cu.role AS company_role
    FROM users u
    JOIN company_users cu ON cu.user_id::TEXT = u.id
    WHERE cu.company_id = ${companyId}::UUID
      AND u.is_active = true
      AND u.id = ${userId}
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return mapUser(rows[0]!);
}
