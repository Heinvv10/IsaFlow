/**
 * Permission Service — Granular module-level permissions (WS-4.1).
 * Role defaults: owner/admin → full, manager → read+write+export, viewer → read+export.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

export interface ModulePermission {
  moduleKey: string; moduleName: string;
  canRead: boolean; canWrite: boolean; canDelete: boolean;
  canExport: boolean; canApprove: boolean;
  accountRangeFrom: string | null; accountRangeTo: string | null;
  restrictions: Record<string, unknown>;
}
export interface PermissionModule {
  moduleKey: string; moduleName: string; description: string | null; displayOrder: number;
}
export interface UserWithPermissions {
  userId: string; email: string; firstName: string; lastName: string;
  role: string; permissions: ModulePermission[];
}

type Action = 'read' | 'write' | 'delete' | 'export' | 'approve';
type Row = Record<string, unknown>;

const FULL_ACCESS_ROLES = ['owner', 'admin'];

function roleDefault(role: string, action: Action): boolean {
  if (FULL_ACCESS_ROLES.includes(role)) return true;
  if (role === 'manager') return action === 'read' || action === 'write' || action === 'export';
  if (role === 'viewer') return action === 'read' || action === 'export';
  return false;
}

function defaultPerm(role: string, moduleKey: string, moduleName: string): ModulePermission {
  return {
    moduleKey, moduleName,
    canRead: roleDefault(role, 'read'), canWrite: roleDefault(role, 'write'),
    canDelete: roleDefault(role, 'delete'), canExport: roleDefault(role, 'export'),
    canApprove: roleDefault(role, 'approve'),
    accountRangeFrom: null, accountRangeTo: null, restrictions: {},
  };
}

function rowToPerm(r: Row): ModulePermission {
  return {
    moduleKey: r.module_key as string, moduleName: r.module_name as string,
    canRead: Boolean(r.can_read), canWrite: Boolean(r.can_write),
    canDelete: Boolean(r.can_delete), canExport: Boolean(r.can_export),
    canApprove: Boolean(r.can_approve),
    accountRangeFrom: r.account_range_from as string | null,
    accountRangeTo: r.account_range_to as string | null,
    restrictions: (r.restrictions as Record<string, unknown>) ?? {},
  };
}

export async function getPermissionModules(): Promise<PermissionModule[]> {
  const rows = await sql`
    SELECT module_key, module_name, description, display_order
    FROM permission_modules ORDER BY display_order ASC
  `;
  return rows.map((r: Row) => ({
    moduleKey: r.module_key as string, moduleName: r.module_name as string,
    description: r.description as string | null, displayOrder: r.display_order as number,
  }));
}

export async function getUserPermissions(
  companyId: string, userId: string
): Promise<Map<string, ModulePermission>> {
  const rows = await sql`
    SELECT cup.module_key, pm.module_name, cup.can_read, cup.can_write,
      cup.can_delete, cup.can_export, cup.can_approve,
      cup.account_range_from, cup.account_range_to, cup.restrictions
    FROM company_user_permissions cup
    JOIN permission_modules pm ON pm.module_key = cup.module_key
    WHERE cup.company_id = ${companyId}::UUID AND cup.user_id = ${userId}
  `;
  const map = new Map<string, ModulePermission>();
  for (const r of rows as Row[]) map.set(r.module_key as string, rowToPerm(r));
  return map;
}

export async function setUserModulePermission(
  companyId: string, userId: string, moduleKey: string, perms: Partial<ModulePermission>
): Promise<void> {
  await sql`
    INSERT INTO company_user_permissions (
      company_id, user_id, module_key,
      can_read, can_write, can_delete, can_export, can_approve,
      account_range_from, account_range_to, restrictions, updated_at
    ) VALUES (
      ${companyId}::UUID, ${userId}, ${moduleKey},
      ${perms.canRead ?? false}, ${perms.canWrite ?? false}, ${perms.canDelete ?? false},
      ${perms.canExport ?? false}, ${perms.canApprove ?? false},
      ${perms.accountRangeFrom ?? null}, ${perms.accountRangeTo ?? null},
      ${JSON.stringify(perms.restrictions ?? {})}::JSONB, NOW()
    )
    ON CONFLICT (company_id, user_id, module_key) DO UPDATE SET
      can_read = EXCLUDED.can_read, can_write = EXCLUDED.can_write,
      can_delete = EXCLUDED.can_delete, can_export = EXCLUDED.can_export,
      can_approve = EXCLUDED.can_approve,
      account_range_from = EXCLUDED.account_range_from,
      account_range_to   = EXCLUDED.account_range_to,
      restrictions       = EXCLUDED.restrictions,
      updated_at         = NOW()
  `;
  log.info('Module permission updated', { companyId, userId, moduleKey }, 'PermissionService');
}

export async function resetUserPermissions(companyId: string, userId: string): Promise<void> {
  await sql`
    DELETE FROM company_user_permissions
    WHERE company_id = ${companyId}::UUID AND user_id = ${userId}
  `;
  log.info('User permissions reset to defaults', { companyId, userId }, 'PermissionService');
}

export async function checkPermission(
  companyId: string, userId: string, companyRole: string, moduleKey: string, action: Action
): Promise<boolean> {
  if (FULL_ACCESS_ROLES.includes(companyRole)) return true;

  const rows = await sql`
    SELECT can_read, can_write, can_delete, can_export, can_approve
    FROM company_user_permissions
    WHERE company_id = ${companyId}::UUID
      AND user_id    = ${userId}
      AND module_key = ${moduleKey}
    LIMIT 1
  `;
  if (rows.length > 0) {
    const r = rows[0] as Row;
    const col = `can_${action}` as keyof typeof r;
    return Boolean(r[col]);
  }
  return roleDefault(companyRole, action);
}

export async function getCompanyUsersWithPermissions(companyId: string): Promise<UserWithPermissions[]> {
  const userRows = await sql`
    SELECT cu.user_id, cu.role, u.email, u.first_name, u.last_name
    FROM company_users cu
    JOIN users u ON u.id = cu.user_id
    WHERE cu.company_id = ${companyId}::UUID
    ORDER BY cu.created_at ASC
  `;
  if (userRows.length === 0) return [];

  const modules = await getPermissionModules();

  const permRows = await sql`
    SELECT cup.user_id, cup.module_key, pm.module_name,
      cup.can_read, cup.can_write, cup.can_delete, cup.can_export, cup.can_approve,
      cup.account_range_from, cup.account_range_to, cup.restrictions
    FROM company_user_permissions cup
    JOIN permission_modules pm ON pm.module_key = cup.module_key
    WHERE cup.company_id = ${companyId}::UUID
  `;

  const customMap = new Map<string, Map<string, ModulePermission>>();
  for (const r of permRows as Row[]) {
    const uid = r.user_id as string;
    if (!customMap.has(uid)) customMap.set(uid, new Map());
    customMap.get(uid)!.set(r.module_key as string, rowToPerm(r));
  }

  return (userRows as Row[]).map((u: Row) => {
    const role = u.role as string;
    const uid = u.user_id as string;
    const custom = customMap.get(uid);
    const isFullAccess = FULL_ACCESS_ROLES.includes(role);

    const permissions: ModulePermission[] = modules.map((mod) => {
      if (isFullAccess) {
        return {
          moduleKey: mod.moduleKey, moduleName: mod.moduleName,
          canRead: true, canWrite: true, canDelete: true, canExport: true, canApprove: true,
          accountRangeFrom: null, accountRangeTo: null, restrictions: {},
        };
      }
      return custom?.get(mod.moduleKey) ?? defaultPerm(role, mod.moduleKey, mod.moduleName);
    });

    return {
      userId: uid, email: u.email as string,
      firstName: (u.first_name as string) ?? '',
      lastName: (u.last_name as string) ?? '',
      role, permissions,
    };
  });
}
