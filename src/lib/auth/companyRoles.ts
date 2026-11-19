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
 * accountant / bookkeeper to give a person working access, but the app let neither write
 * (withWriteAccess admits owner, admin, manager): every write was a 403. Both map to manager,
 * the app role that writes, but WITHOUT approve (Hein, 2026-11-19: no approval power they never
 * had; LEGACY_ROLES_WITHOUT_APPROVE). storeman / technician (the legacy invitation route) and
 * `user` (the old company_users.role column default) were read-only and map to viewer.
 * Migration 1010 rewrites stored rows (backup in role_values_1656_backup) and writes the
 * can_approve=false rows; normalizeCompanyRole and roleDefaultPermission cover a row that
 * arrives after it.
 */
export const LEGACY_ROLE_MAP: Readonly<Record<string, CompanyRole>> = Object.freeze({
  accountant: 'manager',
  bookkeeper: 'manager',
  storeman: 'viewer',
  technician: 'viewer',
  user: 'viewer',
});

/** Legacy values promoted to manager that do not gain approve (no company_user_permissions row needed). */
export const LEGACY_ROLES_WITHOUT_APPROVE: ReadonlySet<string> = new Set(['accountant', 'bookkeeper']);

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
 * Whether a manager may approve when no company_user_permissions row says otherwise. Hein,
 * 2026-11-19 (#1656): yes ("B", after the evidence that the budget checks (P5-2) are built on
 * managers approving bills); an owner or admin takes it away per module by unticking Approve.
 */
export const MANAGER_APPROVES_BY_DEFAULT = true;

/**
 * What a role may do on a module when the user has no company_user_permissions row for it:
 * owner/admin everything; manager read, write, export, and approve per MANAGER_APPROVES_BY_DEFAULT
 * (never delete); viewer read, export. Pass the STORED role: a legacy accountant/bookkeeper reads
 * as a manager without approve.
 */
export function roleDefaultPermission(role: string, action: PermissionAction): boolean {
  if (action === 'approve' && LEGACY_ROLES_WITHOUT_APPROVE.has(role)) return false;
  const effective = normalizeCompanyRole(role);
  if (isFullAccessRole(effective)) return true;
  if (effective === 'manager') {
    if (action === 'approve') return MANAGER_APPROVES_BY_DEFAULT;
    return action === 'read' || action === 'write' || action === 'export';
  }
  if (effective === 'viewer') return action === 'read' || action === 'export';
  return false;
}
