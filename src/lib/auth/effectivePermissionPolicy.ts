import type { ModulePermission } from './permissionService';

type Action = 'canRead' | 'canWrite' | 'canApprove';
interface PermissionRule { modules: readonly string[]; action: Action; explicitManager?: boolean; requires?: readonly string[] }
const rule = (modules: string[], action: Action, explicitManager = false): PermissionRule => ({ modules, action, explicitManager });
/** Cross-domain scopes conservatively require BOTH domains; adapters may not use a broad scope to evade a deny. */
export const EFFECTIVE_PERMISSION_RULES: Readonly<Record<string, PermissionRule>> = {
  'read:invoices': rule(['customers', 'suppliers'], 'canRead'),
  'write:invoices': rule(['customers', 'suppliers'], 'canWrite'),
  'read:bank-tx': rule(['banking'], 'canRead'),
  'write:bank-tx': rule(['banking'], 'canWrite'),
  'write:journals': rule(['accounts'], 'canWrite'),
  'write:accounts': rule(['accounts'], 'canWrite'),
  'read:assets': rule(['assets'], 'canRead'),
  'write:assets': rule(['assets'], 'canWrite'),
  'read:reports': rule(['reports'], 'canRead'),
  'read:contacts': rule(['customers', 'suppliers'], 'canRead'),
  'write:contacts': rule(['customers', 'suppliers'], 'canWrite'),
  'read:vat': rule(['vat'], 'canRead'),
  'read:practice': rule(['accountant'], 'canRead'),
  'write:practice': rule(['accountant'], 'canWrite'),
  'read:payroll': rule(['payroll'], 'canRead'),
  'write:payroll': rule(['payroll'], 'canWrite'),
  'write:post': rule(['accounts'], 'canWrite'),
  'read:approvals': rule(['approvals'], 'canRead'),
  'write:approvals': rule(['approvals'], 'canApprove', true),
  'write:beneficiaries': rule(['beneficiaries'], 'canWrite', true),
  'read:access': rule(['access'], 'canRead', true),
  'read:audit': rule(['audit'], 'canRead'),
  'write:audit': rule(['audit'], 'canWrite', true),
  'write:release': rule(['release'], 'canApprove', true),
  'write:locks': rule(['locks'], 'canApprove', true),
  'write:controls': rule(['controls'], 'canApprove', true),
  'read:payroll-sensitive': { ...rule(['payroll_sensitive'], 'canRead', true), requires: ['read:payroll'] },
};
export type PermissionReason = 'UNKNOWN_PERMISSION' | 'ROLE_CEILING' | 'MISSING_SCOPE' | 'MODULE_DENIED' | 'ENTITY_REQUIRED';
export function hasConstraints(p: ModulePermission): boolean {
  return p.accountRangeFrom !== null || p.accountRangeTo !== null
    || p.restrictions === null || typeof p.restrictions !== 'object'
    || Array.isArray(p.restrictions) || Object.keys(p.restrictions).length > 0;
}
export function permissionReason(role: string, permission: string, scopes: readonly string[] | null,
  overrides: readonly ModulePermission[], allowConstraints = false): PermissionReason | null {
  const spec = EFFECTIVE_PERMISSION_RULES[permission];
  if (!spec || !Object.hasOwn(EFFECTIVE_PERMISSION_RULES, permission)) return 'UNKNOWN_PERMISSION';
  if (!['owner', 'admin', 'manager', 'viewer'].includes(role)
    || (role === 'viewer' && spec.action !== 'canRead')
    || (role === 'viewer' && spec.explicitManager)) return 'ROLE_CEILING';
  if (scopes !== null && (!scopes.includes(permission) || spec.requires?.some(s => !scopes.includes(s)))) return 'MISSING_SCOPE';
  for (const dependency of spec.requires ?? []) {
    const reason = permissionReason(role, dependency, scopes, overrides, allowConstraints);
    if (reason) return reason;
  }
  for (const module of spec.modules) {
    const matches = overrides.filter(p => p.moduleKey === module);
    if (matches.length > 1) return 'MODULE_DENIED';
    const override = matches[0];
    if (override ? override[spec.action] !== true : role === 'manager' && spec.explicitManager) return 'MODULE_DENIED';
    if (override && hasConstraints(override) && !allowConstraints) return 'ENTITY_REQUIRED';
  }
  return null;
}
/** Pure attenuation only. This does not authenticate membership or a token. */
export function attenuateGrantedScopes(role: string, grantedScopes: readonly string[],
  currentModuleOverrides: readonly ModulePermission[]): string[] {
  return [...new Set(grantedScopes)].filter(scope => permissionReason(role, scope, grantedScopes, currentModuleOverrides) === null);
}
