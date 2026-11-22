/**
 * The caller's own effective module permissions: what the nav needs to hide a module the user cannot read.
 * Decided exactly as the routes decide it (`memberMay`, the rule behind `checkPermission`): from the user's STORED role
 * in this company (not a member: nothing), owner/admin everything, else their company_user_permissions row, else the
 * role default (honouring approve_withheld). One query, this company and this user only.
 * Payroll is answered even when permission_modules has no 'payroll' row (a schema-only database such as the hosted
 * Golden Paths one): checkPermission, which the Payroll routes call, never reads permission_modules, so neither may this.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { memberMay } from './permissionService';

export interface MyModuleAccess { read: boolean; write: boolean; approve: boolean }

export async function getMyModulePermissions(companyId: string, userId: string): Promise<Record<string, MyModuleAccess>> {
  const rows = await sql`
    SELECT pm.module_key, cu.role, cu.approve_withheld,
      p.can_read, p.can_write, p.can_delete, p.can_export, p.can_approve, (p.module_key IS NOT NULL) AS has_row
    FROM company_users cu
    CROSS JOIN (SELECT module_key FROM permission_modules UNION SELECT 'payroll') pm
    LEFT JOIN company_user_permissions p
      ON p.company_id = cu.company_id AND p.user_id = cu.user_id AND p.module_key = pm.module_key
    WHERE cu.company_id = ${companyId}::UUID AND cu.user_id = ${userId}
  `;
  const out: Record<string, MyModuleAccess> = {};
  for (const r of rows as DbRow[]) {
    const key = String(r.module_key);
    out[key] = { read: memberMay(r, 'read', key), write: memberMay(r, 'write', key), approve: memberMay(r, 'approve', key) };
  }
  return out;
}
