import { operationPermission } from './operationPermissions';
import { isActiveUserAccount } from '@/lib/auth/userAccountStatus';
import type { ModulePermission } from '@/lib/auth/permissionService';
import { assertControlTx } from './context';
import { SuppliedApprovalRefusal } from './suppliedApprovalRefusal';
import { canonicalJson, operationBindingHash } from './canonical';
import type { ControlTx, EvidenceRef, OperationApproval, OperationBinding, PolicyBinding } from './contracts';

export interface ApprovalRow {
  id: string; company_id: string; operation_id: string; requester_person_id: string; requester_auth_method: string;
  binding: OperationBinding; binding_hash: string; status: OperationApproval['status'];
  requested_at: Date | string; expires_at: Date | string; unexpired: boolean; consumed_effect_id: string | null;
}
export interface DecisionRow { policy_id: string; person_id: string; decision: 'approved' | 'rejected'; evidence_refs: EvidenceRef[] }
export interface AuthorityRow {
  person_id: string; role: string | null; authority_kind?: 'member' | 'platform_import'; platform_role?: string | null; is_active: boolean | null; status: string | null;
  suspended_at: Date | string | null; company_status: string | null; company_suspended_at: Date | string | null;
  permissions: Array<Record<string, unknown>>; grant_valid: boolean; current_scopes: string[] | null;
}
export interface ApprovalSummary {
  id: string; status: OperationApproval['status']; operation: string; entityType: string; entityId: string;
  requestedAt: string; expiresAt: string;
}
export function approvalSummary(row: ApprovalRow): ApprovalSummary {
  const iso = (date: Date | string) => date instanceof Date ? date.toISOString() : date;
  return { id: row.id, status: row.status, operation: row.binding.operation, entityType: row.binding.entityType,
    entityId: row.binding.entityId, requestedAt: iso(row.requested_at), expiresAt: iso(row.expires_at) };
}
export async function lockApproval(ctx: ControlTx, id: string): Promise<ApprovalRow> {
  assertControlTx(ctx);
  const rows = await ctx.sql`
    SELECT *,expires_at>clock_timestamp() AS unexpired FROM control_operation_approvals
    WHERE company_id=${ctx.principal.companyId}::uuid AND id=${id}::uuid FOR UPDATE
  ` as ApprovalRow[];
  if (!rows[0]) throw new SuppliedApprovalRefusal('Approval not found');
  if (operationBindingHash(rows[0].binding) !== rows[0].binding_hash) throw new Error('Approval material is invalid');
  return rows[0];
}
export async function approvalAuthorities(ctx: ControlTx, id: string): Promise<AuthorityRow[]> {
  assertControlTx(ctx);
  return await ctx.sql`
    SELECT * FROM public.control_approval_authorities(${ctx.principal.companyId}::uuid,${id}::uuid)
  ` as AuthorityRow[];
}
export async function approvalDecisions(ctx: ControlTx, id: string): Promise<DecisionRow[]> {
  return await ctx.sql`
    SELECT policy_id,person_id,decision,evidence_refs FROM control_operation_decisions
    WHERE company_id=${ctx.principal.companyId}::uuid AND approval_id=${id}::uuid ORDER BY policy_id
  ` as DecisionRow[];
}
export async function assertApprovalAuthority(authority: AuthorityRow | undefined, permission: string, role?: string): Promise<void> {
  const { permissionReason } = await import('@/lib/auth/effectivePermissionPolicy');
  if (!authority || authority.authority_kind === 'platform_import' || !authority.role || authority.grant_valid !== true
    || (authority.current_scopes !== null && (!Array.isArray(authority.current_scopes)
      || authority.current_scopes.some(scope => typeof scope !== 'string'))) || !isActiveUserAccount(authority) || authority.company_suspended_at !== null
    || ['suspended', 'deleted'].includes(authority.company_status ?? '')
    || (role !== undefined && authority.role !== role) || !Array.isArray(authority.permissions)) throw new SuppliedApprovalRefusal('Approval authority is no longer valid');
  const overrides: ModulePermission[] = authority.permissions.map(row => ({
    moduleKey: String(row.module_key), moduleName: String(row.module_key), canRead: row.can_read === true,
    canWrite: row.can_write === true, canDelete: row.can_delete === true, canExport: row.can_export === true,
    canApprove: row.can_approve === true, accountRangeFrom: row.account_range_from == null ? null : String(row.account_range_from),
    accountRangeTo: row.account_range_to == null ? null : String(row.account_range_to), restrictions: row.restrictions as Record<string, unknown>,
  }));
  if (permissionReason(authority.role, permission, authority.current_scopes, overrides)) throw new SuppliedApprovalRefusal('Approval authority is no longer valid');
}
export async function assertRequesterAuthority(ctx: ControlTx, row: ApprovalRow, authorities: AuthorityRow[]): Promise<void> {
  const requester = authorities.find(person => person.person_id === row.requester_person_id);
  if(row.requester_auth_method==='platform_import'){
    const {assertPlatformImportRequester}=await import('./platformImportRequesterAuthority');
    return assertPlatformImportRequester(ctx,row,requester);
  }
  if (!['cookie', 'pat', 'oauth'].includes(row.requester_auth_method)
    || (row.requester_auth_method !== 'cookie' && !Array.isArray(requester?.current_scopes))) {
    throw new SuppliedApprovalRefusal('Requester grant authority is no longer valid');
  }
  await assertApprovalAuthority(requester, operationPermission(row.binding.operation,'write'));
  await assertApprovalAuthority(requester, 'write:approvals');
}
export async function validateDecisions(ctx: ControlTx, row: ApprovalRow, decisions: DecisionRow[], authorities: AuthorityRow[]): Promise<void> {
  for (const policy of row.binding.policies) {
    const decision = decisions.find(d => d.policy_id === policy.policyId);
    if (!decision || decision.decision !== 'approved' || decision.person_id === row.requester_person_id) throw new SuppliedApprovalRefusal('Independent approval is required');
    const authority = authorities.find(person => person.person_id === decision.person_id);
    await assertApprovalAuthority(authority, 'write:approvals', policy.approverRole);
    await assertApprovalAuthority(authority, operationPermission(row.binding.operation,'read'));
    await validateApprovalEvidence(ctx, row.binding, decision.evidence_refs);
  }
}
export function pendingPolicies(policies: readonly PolicyBinding[], decisions: readonly DecisionRow[], role: string): PolicyBinding[] {
  return policies.filter(policy => policy.approverRole === role && !decisions.some(row => row.policy_id === policy.policyId));
}
export async function validateApprovalEvidence(ctx: ControlTx, binding: OperationBinding, refs: readonly EvidenceRef[]): Promise<void> {
  canonicalJson(refs);
  if (refs.length > 20) throw new Error('Too many approval evidence links');
  for (const ref of refs) {
    if (ref.version !== null || (ref.store === 'procurement' && ref.hash !== null)) throw new Error('Evidence version/hash cannot be verified by this store');
    if (ref.entityId !== binding.entityId || ref.entityType !== binding.entityType) throw new Error('Evidence parent does not match approval');
    let found: unknown[];
    if (ref.store === 'captured') {
      found = await ctx.sql`
        SELECT cd.id FROM captured_documents cd
        WHERE cd.company_id=${ctx.principal.companyId}::uuid AND cd.id=${ref.evidenceId}::uuid
          AND (${ref.hash}::text IS NULL OR cd.raw_bytes_sha256=${ref.hash})
          AND EXISTS(SELECT 1 FROM supplier_invoices si
            WHERE si.company_id=${ctx.principal.companyId}::uuid AND si.source_document_id=cd.id
              AND ((${binding.entityType}='supplier_invoice' AND si.id=${binding.entityId}::uuid)
                OR (${binding.entityType}='supplier_payment' AND EXISTS(
                  SELECT 1 FROM payment_allocations pa JOIN supplier_payments sp ON sp.id=pa.payment_id
                  WHERE sp.company_id=${ctx.principal.companyId}::uuid AND sp.id=${binding.entityId}::uuid
                    AND pa.invoice_id=si.id AND si.supplier_id=sp.supplier_id))))
        FOR SHARE OF cd
      `;
    } else if (ref.store === 'procurement') {
      // The legacy supplier_invoice document discriminator identifies Sage, not native invoices.
      if (binding.entityType === 'supplier_invoice') throw new Error('Unsupported native procurement evidence parent');
      found = await ctx.sql`
        SELECT pd.id FROM procurement_documents pd WHERE pd.id=${ref.evidenceId}::uuid AND pd.is_active=true
          AND pd.entity_type=${binding.entityType} AND pd.entity_id=${binding.entityId}::uuid
          AND EXISTS(SELECT 1 FROM supplier_payments sp WHERE sp.company_id=${ctx.principal.companyId}::uuid
            AND sp.id=pd.entity_id AND pd.entity_type='supplier_payment')
      `;
    } else { throw new Error('Unsupported approval evidence store'); }
    if (found.length !== 1) throw new Error('Approval evidence not found');
  }
}
