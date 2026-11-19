/**
 * The ONE place the role vocabulary is defined (#1656, Hein 2026-11-19: the app model wins).
 *
 * A company member (company_users.role, company_invitations.role) holds exactly one of
 * COMPANY_ROLES; what each role may do per module is roleDefaultPermission, overridden per
 * user by company_user_permissions (Settings -> User Access and the admin portal edit the
 * same rows). The admin portal grants the same roles except `owner` (migrations 883/1010
 * refuse it from the platform_admin role; an owner grants owner in the app).
 *
 * No imports: pages, components and server code all read it.
 * tests/unit/auth/roleListCensus.test.ts fails when a role list is written anywhere else.
 */

/** Company roles, highest authority first. */
export const COMPANY_ROLES = ['owner', 'admin', 'manager', 'viewer'] as const;
export type CompanyRole = (typeof COMPANY_ROLES)[number];

export function isCompanyRole(value: unknown): value is CompanyRole {
  return typeof value === 'string' && (COMPANY_ROLES as readonly string[]).includes(value);
}

/** Every company role but owner: what the admin portal grants, and the platform users.role values it may set. */
export const NON_OWNER_COMPANY_ROLES = COMPANY_ROLES.filter(
  (role): role is Exclude<CompanyRole, 'owner'> => role !== 'owner',
);

/**
 * users.role, the platform role: super_admin (the admin portal), system (service accounts), or a
 * company role. Only super_admin grants anything; tenant access comes from company_users.role.
 */
export type AuthRole = 'super_admin' | 'system' | CompanyRole;

/** The users.role values code writes or filters on (users_role_check also still admits the legacy accountant/bookkeeper). */
export const PLATFORM_USER_ROLES = ['super_admin', ...NON_OWNER_COMPANY_ROLES, 'system'] as const;

/**
 * A bureau (accounting practice) member's role, bureau_users.role: a separate table and vocabulary
 * from company roles (the firm's own staff, not a client company's members). Here so the census
 * finds every role list in one file.
 */
export const BUREAU_ROLES = ['owner', 'accountant', 'viewer'] as const;
export type BureauRole = (typeof BUREAU_ROLES)[number];

/**
 * Role values written before #1656 and what each now reads as. The admin portal granted
 * accountant / bookkeeper, the legacy invitation route storeman / technician, and `user` is
 * company_users.role's column default. None of them could write (withWriteAccess admits owner,
 * admin, manager), so each maps to viewer: nobody gains access they did not have.
 * Migration 1010 rewrites stored rows (backup in role_values_1656_backup); normalizeCompanyRole
 * covers a row that arrives after it.
 */
export const LEGACY_ROLE_MAP: Readonly<Record<string, CompanyRole>> = Object.freeze({
  accountant: 'viewer',
  bookkeeper: 'viewer',
  storeman: 'viewer',
  technician: 'viewer',
  user: 'viewer',
});

/** A stored role as the app reads it: a legacy value maps (LEGACY_ROLE_MAP); anything else is returned unchanged. */
export function normalizeCompanyRole(role: string): string {
  return Object.prototype.hasOwnProperty.call(LEGACY_ROLE_MAP, role) ? LEGACY_ROLE_MAP[role]! : role;
}

/** The per-module actions company_user_permissions stores (can_read ... can_approve). */
export const PERMISSION_ACTIONS = ['read', 'write', 'delete', 'export', 'approve'] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

/** Roles that hold every action on every module; their permissions cannot be restricted. */
export const FULL_ACCESS_ROLES = ['owner', 'admin'] as const;

export function isFullAccessRole(role: string): boolean {
  return (FULL_ACCESS_ROLES as readonly string[]).includes(role);
}

/**
 * What a role may do on a module when the user has no company_user_permissions row for it:
 * owner/admin everything; manager everything but delete; viewer read, export.
 * Manager keeps approve by default (#1656): managers approve bills today and the budget checks
 * (P5-2) are built on it; an owner or admin takes it away per module by unticking Approve.
 */
export function roleDefaultPermission(role: string, action: PermissionAction): boolean {
  const effective = normalizeCompanyRole(role);
  if (isFullAccessRole(effective)) return true;
  if (effective === 'manager') return action !== 'delete';
  if (effective === 'viewer') return action === 'read' || action === 'export';
  return false;
}
