import {platformImportPermissions,assertPlatformImportPermission} from './platformImportPermissions';
import type { ControlTx, EntityRef } from '@/modules/accounting/services/controls/contracts';
import { EFFECTIVE_PERMISSION_RULES, hasConstraints, permissionReason, type PermissionReason } from './effectivePermissionPolicy';
import { EffectivePermissionError, loadPermissionState } from './effectivePermissionQueries';

export { EFFECTIVE_PERMISSION_RULES, attenuateGrantedScopes } from './effectivePermissionPolicy';
export { EffectivePermissionError } from './effectivePermissionQueries';
export interface EffectivePermissions {
  companyId: string; personId: string; role: string;
  /** Unconstrained allowed permissions only; conditional access never masquerades as allowed. */
  permissions: string[];
  denied: Record<string, PermissionReason>;
}
/** Current authority is reloaded for every call; the context must be issued by the active authenticated request. */
export async function resolveEffectivePermissions(ctx: ControlTx): Promise<EffectivePermissions> {
  if(ctx.principal.authMethod==='platform_import')return platformImportPermissions(ctx);
  const state = await loadPermissionState(ctx);
  const permissions: string[] = [], denied: Record<string, PermissionReason> = {};
  for (const permission of Object.keys(EFFECTIVE_PERMISSION_RULES)) {
    const reason = permissionReason(state.role, permission, state.scopes, state.overrides);
    if (reason) denied[permission] = reason; else permissions.push(permission);
  }
  return { companyId: ctx.principal.companyId, personId: ctx.principal.personId,
    role: state.role, permissions, denied };
}
export async function assertEffectivePermission(ctx: ControlTx, permission: string, entity?: EntityRef): Promise<void> {
  if(ctx.principal.authMethod==='platform_import')return assertPlatformImportPermission(ctx,permission);
  const state = await loadPermissionState(ctx);
  const reason = permissionReason(state.role, permission, state.scopes, state.overrides, true);
  if (reason) throw new EffectivePermissionError(permission, reason);
  const spec = EFFECTIVE_PERMISSION_RULES[permission]!;
  const modules = [...spec.modules, ...(spec.requires ?? []).flatMap(s => EFFECTIVE_PERMISSION_RULES[s]!.modules)];
  const constrained = state.overrides.filter(p => modules.includes(p.moduleKey) && hasConstraints(p));
  if (!constrained.length) return;
  // Unknown restrictions cannot safely be inferred from an ID. Fail closed even with an entity.
  if (constrained.some(p => p.restrictions === null || typeof p.restrictions !== 'object'
    || Array.isArray(p.restrictions) || Object.keys(p.restrictions).length > 0)
    || !entity || entity.entityType !== 'gl_account'
    || constrained.some(p => p.moduleKey !== 'accounts')
    || permission !== 'write:accounts') throw new EffectivePermissionError(permission, 'ENTITY_REQUIRED');
  const rows = await ctx.sql`
    SELECT account_code FROM gl_accounts
    WHERE company_id = ${ctx.principal.companyId}::uuid AND id = ${entity.entityId}::uuid
    FOR SHARE
  ` as Array<{ account_code: string }>;
  const code = rows[0]?.account_code;
  // No account to check. The lookup is company-scoped, so a missing account and
  // ANOTHER TENANT'S are the same zero-row answer and stay indistinguishable —
  // that is the tenant boundary this reason protects. Inside the company the
  // two replies do differ ("not found" vs "outside your range"), deliberately:
  // the account range constrains write:accounts only, this caller can already
  // list the company's accounts, so which of its own ids exists is not news.
  if (rows.length !== 1 || typeof code !== 'string') throw new EffectivePermissionError(permission, 'ACCOUNT_NOT_FOUND');
  if (constrained.some(p =>
    (p.accountRangeFrom !== null && code < p.accountRangeFrom)
    || (p.accountRangeTo !== null && code > p.accountRangeTo))) throw new EffectivePermissionError(permission, 'ACCOUNT_OUT_OF_RANGE');
}
