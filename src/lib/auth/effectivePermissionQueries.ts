import type { PermissionReason } from './effectivePermissionPolicy';
import { assertControlTx } from '@/modules/accounting/services/controls/context';
import type { ControlTx } from '@/modules/accounting/services/controls/contracts';
import type { ModulePermission } from './permissionService';
import { isActiveUserAccount, type UserAccountRow } from './userAccountStatus';
import {loadStoredAuditJobDelegation} from '@/modules/accounting/services/controls/auditJobDelegation';

export class EffectivePermissionError extends Error {
  readonly code = 'CONTROL_FORBIDDEN';
  /**
   * The permission the caller was missing, where the raiser knows it. The MCP
   * transport turns this into a reply that names the grant to ask for; without
   * it a domain refusal reads as "the operation failed" and the caller has no
   * route to the answer. Scopes are public (consent screen, PAT UI), so naming
   * one leaks nothing.
   */
  /** Why it was refused, so the reply can say what actually blocks the caller. */
  constructor(readonly permission?: string, readonly reason?: PermissionReason) {
    super('Current permissions do not allow this operation.');
    this.name = 'EffectivePermissionError';
  }
}
interface Membership extends UserAccountRow {
  role: string; company_status: string | null; company_suspended_at: Date | string | null;
}
/**
 * Root migration 626 owns the narrow, authenticated principal-lock helper.
 * Direct FOR UPDATE would apply admin-write RLS and hide viewer/manager memberships.
 * Helper locks parent users too: permission INSERT FK cannot overtake absent override.
 */
export async function loadPermissionState(ctx: ControlTx) {
  assertControlTx(ctx);
  const { companyId, personId, connectionId, grantId } = ctx.principal;
  let {authMethod,grantedScopes}=ctx.principal;
  let jobPermissions:readonly string[]|null=null;
  if(authMethod==='job'){
    const saved=await loadStoredAuditJobDelegation(ctx.sql,companyId,personId,{jobId:ctx.principal.jobId??'',
      leaseId:ctx.principal.jobLeaseId??'',generation:ctx.principal.jobGeneration??0});
    if(connectionId!==saved.authority.connectionId||grantId!==saved.authority.grantId)throw new EffectivePermissionError();
    authMethod=saved.authority.authMethod;grantedScopes=saved.authority.grantedScopes;jobPermissions=saved.permissions;
  }
  if (!companyId || !personId || !['cookie', 'pat', 'oauth'].includes(authMethod)) throw new EffectivePermissionError();
  const rows = await ctx.sql`
    SELECT * FROM public.control_lock_permission_principal(${companyId}::uuid, ${personId}::text)
  ` as Membership[];
  const member = rows[0];
  if (rows.length !== 1 || !isActiveUserAccount(member)
    || member!.company_suspended_at != null
    || ['suspended', 'deleted'].includes(member!.company_status ?? '')) throw new EffectivePermissionError();
  let scopes: readonly string[] | null = null;
  if (authMethod !== 'cookie') {
    if (!Array.isArray(grantedScopes)) throw new EffectivePermissionError();
    const id = authMethod === 'pat' ? connectionId : grantId;
    if (!id) throw new EffectivePermissionError();
    const grants = authMethod === 'pat' ? await ctx.sql`
      WITH locked_grant AS MATERIALIZED (
        SELECT scopes, revoked_at, expires_at FROM personal_access_tokens
        WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid AND user_id = ${personId}::text
        FOR SHARE
      ) SELECT scopes, (revoked_at IS NULL AND expires_at > clock_timestamp()) AS valid FROM locked_grant
    ` : await ctx.sql`
      WITH locked_grant AS MATERIALIZED (
        SELECT scopes, revoked_at, access_token_expires_at FROM oauth_authorisations
        WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid AND user_id = ${personId}::text
        FOR SHARE
      ) SELECT scopes, (revoked_at IS NULL AND access_token_expires_at > clock_timestamp()) AS valid FROM locked_grant
    `;
    const grant = grants[0] as { scopes: unknown; valid: boolean } | undefined;
    if (grants.length !== 1 || grant?.valid !== true || !Array.isArray(grant.scopes)
      || grant.scopes.some(s => typeof s !== 'string')) throw new EffectivePermissionError();
    scopes = grantedScopes.filter(s => (grant.scopes as string[]).includes(s));
  }
  if(jobPermissions)scopes=scopes===null?jobPermissions:scopes.filter(scope=>jobPermissions.includes(scope));
  const overrides = await ctx.sql`
    SELECT module_key, can_read, can_write, can_delete, can_export, can_approve,
      account_range_from, account_range_to, restrictions
    FROM company_user_permissions
    WHERE company_id = ${companyId}::uuid AND user_id = ${personId}::text
    ORDER BY module_key FOR SHARE
  ` as Array<Record<string, unknown>>;
  return { role: member!.role, scopes, overrides: overrides.map((p): ModulePermission => ({
    moduleKey: String(p.module_key), moduleName: String(p.module_key),
    canRead: p.can_read === true, canWrite: p.can_write === true, canDelete: p.can_delete === true,
    canExport: p.can_export === true, canApprove: p.can_approve === true,
    accountRangeFrom: p.account_range_from == null ? null : String(p.account_range_from),
    accountRangeTo: p.account_range_to == null ? null : String(p.account_range_to),
    restrictions: p.restrictions as Record<string, unknown>,
  })) };
}
