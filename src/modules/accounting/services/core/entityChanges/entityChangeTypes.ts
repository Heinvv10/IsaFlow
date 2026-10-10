/**
 * Entity change history (forensic-controls step 3, migration 888): the types,
 * and who may read what — the same rules entity_changes' RLS policy enforces
 * (entity_changes_read), stated once here for the routes, the MCP tool and the
 * UI. Pinned to the migration by entityChangeTypes.test.ts.
 */

export const ENTITY_TYPES = [
  'supplier', 'customer', 'gl_account', 'payroll_employee', 'company_user', 'company_invitation',
  'company_user_permission', 'company', 'approval_rule', 'approval_enforcement',
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const CHANNELS = ['session', 'impersonation', 'token', 'platform_admin', 'system'] as const;
export type Channel = (typeof CHANNELS)[number];

export const ENTITY_TYPE_LABELS: Record<EntityType, string> = {
  supplier: 'Supplier',
  customer: 'Customer',
  gl_account: 'GL / bank account',
  payroll_employee: 'Employee',
  company_user: 'Member',
  company_invitation: 'Invitation',
  company_user_permission: 'Member permission',
  company: 'Company settings',
  approval_rule: 'Approval rule',
  approval_enforcement: 'Approval switch',
};

export const CHANNEL_LABELS: Record<Channel, string> = {
  session: 'Signed in',
  impersonation: 'Login-as',
  token: 'API / MCP token',
  platform_admin: 'Platform admin',
  system: 'System',
};

/** Any member may read these (as they may open the entity). */
const MEMBER_TYPES: readonly EntityType[] = ['supplier', 'customer', 'gl_account'];
/** Payroll detail: withPayrollDetailAccess's roles. */
const PAYROLL_ROLES = ['owner', 'admin', 'manager'];
/** Everything else, the company-wide feed, and revealing masked values. */
export const ADMIN_ROLES = ['owner', 'admin'];

export function isEntityType(value: unknown): value is EntityType {
  return typeof value === 'string' && (ENTITY_TYPES as readonly string[]).includes(value);
}

export function mayReadType(role: string | undefined, type: EntityType): boolean {
  if (MEMBER_TYPES.includes(type)) return true;
  if (type === 'payroll_employee') return PAYROLL_ROLES.includes(role ?? '');
  return ADMIN_ROLES.includes(role ?? '');
}

/** The company-wide feed (every entity) and the reveal of a masked value. */
export const isHistoryAdmin = (role: string | undefined): boolean => ADMIN_ROLES.includes(role ?? '');

export interface EntityChangeField {
  key: string;
  before: unknown;
  after: unknown;
  /** True when either side is masked (a bank account, ID or tax number). */
  masked: boolean;
}

export interface EntityChangeView {
  id: string;
  entityType: EntityType;
  entityId: string;
  /** The entity's name or code as it stood after the change (before it, for a delete). */
  entityLabel: string | null;
  op: 'create' | 'update' | 'delete';
  fields: EntityChangeField[];
  actor: string;
  actorName: string | null;
  channel: Channel;
  impersonator: string | null;
  recordedAt: string;
}

export interface EntityChangePage {
  items: EntityChangeView[];
  /** Pass as `before` for the next (older) page — the last change's id; null when there is none. */
  nextCursor: string | null;
}
