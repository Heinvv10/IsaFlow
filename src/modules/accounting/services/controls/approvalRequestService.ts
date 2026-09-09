import type { ApMaterial } from './apOperationMaterializer';
import { operationPermission } from './operationPermissions';
import { withSavepoint } from '@/lib/neon';
import type { ControlTx, EvidenceRef, OperationRef } from './contracts';
import { assertControlTx } from './context';
import { canonicalOperationRef, loadOperationMaterial, reserveOperationExposure } from './operationMaterializer';
import { approvalAuthorities, approvalDecisions, approvalSummary, assertRequesterAuthority, lockApproval,
  pendingPolicies, validateApprovalEvidence, type ApprovalRow } from './approvalQueries';

export async function getApprovalRequirements(ctx: ControlTx, ref: OperationRef) {
  assertControlTx(ctx);
  const { assertEffectivePermission } = await import('@/lib/auth/effectivePermissions');
  await assertEffectivePermission(ctx, operationPermission(ref.operation,'read'));
  const material = await loadOperationMaterial(ctx, ref);
  return { requiresApproval: material.binding.policies.length > 0, policies: material.binding.policies,
    amount: material.binding.amount, currency: material.binding.currency, entityVersion: material.binding.entityVersion,
    versionBasis: material.versionBasis };
}
export async function initializeOperationObservations(ctx: ControlTx, material: Pick<ApMaterial, 'observedSources' | 'binding'>): Promise<void> {
  const { recordCommittedChange } = await import('./changeEventService');
  for (const source of material.observedSources.filter(row => !row.tracked)) {
    await recordCommittedChange(ctx, { entityType: source.entityType, entityId: source.entityId,
      previousVersion: null, newVersion: 1, action: 'baseline_observed', accountingDate: material.binding.accountingDate,
      before: null, after: source.facts, bindingHash: null, protectedEvidenceRef: null });
  }
}
export async function requestOperationApproval(ctx: ControlTx, input: OperationRef) {
  assertControlTx(ctx);
  const ref = canonicalOperationRef(input);
  const { assertEffectivePermission } = await import('@/lib/auth/effectivePermissions');
  await assertEffectivePermission(ctx, 'write:approvals');
  await assertEffectivePermission(ctx, operationPermission(ref.operation,'write'));
  return withSavepoint('control_approval_request', async () => {
    const material = await loadOperationMaterial(ctx, ref);
    await initializeOperationObservations(ctx, material);
    const status = material.binding.policies.length ? 'pending' : 'approved';
    const [row] = await ctx.sql`
      INSERT INTO control_operation_approvals(company_id,operation_id,operation,entity_type,entity_id,
        requester_person_id,requester_auth_method,requester_grant_id,requester_granted_scopes,
        binding,binding_hash,status,requested_at,expires_at)
      VALUES(${ctx.principal.companyId}::uuid,${ctx.principal.operationId}::uuid,${ref.operation},${ref.entityType},${ref.entityId},
        ${ctx.principal.personId},${ctx.principal.authMethod},
        ${ctx.principal.authMethod === 'pat' ? ctx.principal.connectionId : ctx.principal.grantId}::uuid,
        ${ctx.principal.grantedScopes === null ? null : [...ctx.principal.grantedScopes]}::text[],${JSON.stringify(material.binding)}::jsonb,${material.bindingHash},${status},
        clock_timestamp(),clock_timestamp()+interval '1 day') RETURNING *
    ` as ApprovalRow[];
    if (!row) throw new Error('Approval request could not be created');
    await reserveOperationExposure(ctx, material, row.id, 'reserved');
    const { recordCommittedChange } = await import('./changeEventService');
    await recordCommittedChange(ctx, { entityType: 'operation_approval', entityId: row.id,
      previousVersion: null, newVersion: 1, action: 'requested', accountingDate: material.binding.accountingDate,
      before: null, after: { status, binding: material.binding }, bindingHash: material.bindingHash, protectedEvidenceRef: null });
    return approvalSummary(row);
  });
}

/** Person identity and eligible policy decisions are server-derived, never arguments. */
export async function decideOperationApproval(ctx: ControlTx, id: string,
  decision: 'approved' | 'rejected' | 'cancelled', evidence: readonly EvidenceRef[] = []) {
  assertControlTx(ctx);
  if (ctx.principal.authMethod !== 'cookie') throw new Error('An authenticated human decision is required');
  if (!['approved', 'rejected', 'cancelled'].includes(decision)) throw new Error('Invalid approval decision');
  const authorities = await approvalAuthorities(ctx, id); // Sorted people before policy/domain locks.
  const { assertEffectivePermission, resolveEffectivePermissions } = await import('@/lib/auth/effectivePermissions');
  await assertEffectivePermission(ctx, 'write:approvals');
  const actor = await resolveEffectivePermissions(ctx);
  return withSavepoint('control_approval_decision', async () => {
    const [initial] = await ctx.sql`
      SELECT binding FROM control_operation_approvals WHERE company_id=${ctx.principal.companyId}::uuid AND id=${id}::uuid
    ` as Array<{ binding: ApprovalRow['binding'] }>;
    if (!initial) throw new Error('Approval not found');
    await assertEffectivePermission(ctx, operationPermission(initial.binding.operation,'read'));
    const material = await loadOperationMaterial(ctx, initial.binding);
    const row = await lockApproval(ctx, id);
    if (!['pending', 'approved'].includes(row.status) || !row.unexpired) throw new Error('Approval is terminal or expired');
    if (row.binding_hash !== material.bindingHash) throw new Error('Approval material changed');
    if (decision === 'cancelled') {
      if (ctx.principal.personId !== row.requester_person_id) throw new Error('Only the requester can cancel approval');
    } else {
      if (ctx.principal.personId === row.requester_person_id) throw new Error('Self approval is not permitted');
      await assertRequesterAuthority(row, authorities);
      const decisions = await approvalDecisions(ctx, id);
      const eligible = pendingPolicies(row.binding.policies, decisions, actor.role);
      if (!eligible.length) throw new Error('No pending policy accepts this approver role');
      await validateApprovalEvidence(ctx, row.binding, evidence);
      for (const policy of eligible) await ctx.sql`
        INSERT INTO control_operation_decisions(company_id,approval_id,policy_id,person_id,decision,evidence_refs,decided_at)
        VALUES(${ctx.principal.companyId}::uuid,${id}::uuid,${policy.policyId},${ctx.principal.personId},${decision},
          ${JSON.stringify(evidence)}::jsonb,clock_timestamp())
      `;
    }
    const decisions = await approvalDecisions(ctx, id);
    const status = decision === 'cancelled' || decision === 'rejected' ? decision
      : row.binding.policies.every(policy => decisions.some(d => d.policy_id === policy.policyId && d.decision === 'approved')) ? 'approved' : 'pending';
    await ctx.sql`UPDATE control_operation_approvals SET status=${status},decided_at=clock_timestamp()
      WHERE company_id=${ctx.principal.companyId}::uuid AND id=${id}::uuid`;
    const { readControlEntityVersion } = await import('./operationVersions');
    const version = await readControlEntityVersion(ctx, { entityType: 'operation_approval', entityId: id });
    if (!version) throw new Error('Approval version missing');
    const { recordCommittedChange } = await import('./changeEventService');
    await recordCommittedChange(ctx, { entityType: 'operation_approval', entityId: id,
      previousVersion: version.version, newVersion: version.version + 1, action: decision,
      accountingDate: row.binding.accountingDate, before: { status: row.status }, after: { status, decisions },
      bindingHash: row.binding_hash, protectedEvidenceRef: null, operationId: row.operation_id });
    return approvalSummary({ ...row, status });
  });
}
