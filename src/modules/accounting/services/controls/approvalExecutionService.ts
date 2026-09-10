import {assertOperationRequester} from './operationRequester';
import { operationPermission,operationRequiresPosting } from './operationPermissions';
import { randomUUID } from 'node:crypto';
import { withSavepoint } from '@/lib/neon';
import type { ControlTx, OperationRef } from './contracts';
import { assertControlTx } from './context';
import { canonicalJson } from './canonical';
import { approvalAuthorities, approvalDecisions, assertRequesterAuthority, lockApproval, validateDecisions, type ApprovalRow } from './approvalQueries';
import { canonicalOperationRef, loadOperationMaterial, materializeOperation, reserveOperationExposure } from './operationMaterializer';

import { initializeOperationObservations } from './approvalRequestService';

export interface ControlledEffectPermit { readonly operationId: string; readonly accountingDate: string; readonly amount: string | null; readonly currency: string | null; readonly operation: OperationRef['operation']; readonly entityType: string; readonly entityId: string }
const permits = new WeakMap<ControlledEffectPermit, ControlTx>();
const executing = new WeakSet<ControlTx['principal']>();
export function assertControlledEffectPermit(ctx: ControlTx, permit: ControlledEffectPermit, parent: OperationRef): void {
  assertControlTx(ctx);
  const issued = permits.get(permit);
  if (issued) assertControlTx(issued);
  const ref = canonicalOperationRef(parent);
  if (!issued || issued.principal !== ctx.principal || permit.operation !== ref.operation || permit.entityType !== ref.entityType || permit.entityId !== ref.entityId) {
    throw new Error('Controlled effect permission is not valid');
  }
}
export function assertApprovalExecutable(row: ApprovalRow, currentHash: string): void {
  if (row.status !== 'approved' || !row.unexpired) throw new Error('Approval is not executable');
  if (row.binding_hash !== currentHash) throw new Error('Approval material changed');
}

/** Kernel only: owning domain services must call this before their financial effect. */
export async function executeControlledOperation<T>(ctx: ControlTx, input: OperationRef, approvalId: string | null,
  effect: (permit: ControlledEffectPermit) => Promise<T>): Promise<T> {
  assertControlTx(ctx);
  if (executing.has(ctx.principal)) throw new Error('Nested execution requires the parent effect permit');
  const ref = canonicalOperationRef(input);
  const authorities = approvalId ? await approvalAuthorities(ctx, approvalId) : [];
  const { assertEffectivePermission } = await import('@/lib/auth/effectivePermissions');
  await assertEffectivePermission(ctx, operationPermission(ref.operation,'write'));
  if(operationRequiresPosting(ref.operation)) await assertEffectivePermission(ctx, 'write:post');
  return withSavepoint('controlled_ap_operation', async () => {
    // Preserve policy-before-approval lock order, including replay lookups.
    await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-policy:${ctx.principal.companyId}`},0))`;
    const row = approvalId ? await lockApproval(ctx, approvalId) : null;
    if (row) {
      await assertOperationRequester(ctx,ref,row.requester_person_id);
      await assertRequesterAuthority(row, authorities);
      await validateDecisions(ctx, row, await approvalDecisions(ctx, row.id), authorities);
    }
    const operationId = row?.operation_id ?? ctx.principal.operationId;
    const [committed] = await ctx.sql`
      SELECT id,result FROM control_operation_effects WHERE company_id=${ctx.principal.companyId}::uuid
        AND operation=${ref.operation} AND entity_type=${ref.entityType} AND lower(entity_id)=${ref.entityId}
        AND operation_id=${operationId}::uuid
    ` as Array<{ id: string; result: T }>;
    if (committed) {
      if (row && (row.status !== 'consumed' || row.consumed_effect_id !== committed.id)) throw new Error('Approval effect linkage is invalid');
      return committed.result;
    }
    const material = await loadOperationMaterial(ctx, ref);
    if (material.binding.policies.length && !row) throw new Error('Independent operation approval is required');
    if (row) assertApprovalExecutable(row, material.bindingHash);
    const prior = await ctx.sql`
      SELECT id FROM control_operation_effects WHERE company_id=${ctx.principal.companyId}::uuid
        AND operation=${ref.operation} AND entity_type=${ref.entityType} AND lower(entity_id)=${ref.entityId}
        AND binding_hash=${material.bindingHash}
    `;
    if (prior.length) throw new Error('Operation effect already committed');
    const accountingDate=material.binding.accountingDate;
    if (!accountingDate) throw new Error('Financial operation accounting date is required');
    await initializeOperationObservations(ctx, material);
    const permit = Object.freeze({ operationId, accountingDate, amount:material.binding.amount, currency:material.binding.currency, operation: ref.operation, entityType: ref.entityType, entityId: ref.entityId });
    permits.set(permit, ctx); executing.add(ctx.principal);
    let result: T;
    try { result = await effect(permit); } finally { permits.delete(permit); executing.delete(ctx.principal); }
    const effectId = randomUUID();
    await ctx.sql`
      INSERT INTO control_operation_effects(company_id,id,operation_id,operation,entity_type,entity_id,binding_hash,result,committed_at)
      VALUES(${ctx.principal.companyId}::uuid,${effectId}::uuid,${operationId}::uuid,${ref.operation},${ref.entityType},${ref.entityId},
        ${material.bindingHash},${canonicalJson(result)}::jsonb,clock_timestamp())
    `;
    await reserveOperationExposure(ctx, material, row?.id ?? null, 'committed');
    const { recordCommittedChange } = await import('./changeEventService');
    const after = await materializeOperation(ctx, ['journal.reverse','supplier_payment.void','supplier_invoice.cancel','payroll_run.reopen','customer_invoice.cancel','customer_payment.cancel','credit_note.cancel'].includes(ref.operation) ? {...ref,reversalDate:accountingDate} : ref);
    const parent = (sources: typeof after.observedSources) => sources.find(source => source.entityType === ref.entityType && source.entityId === ref.entityId)!.facts;
    await recordCommittedChange(ctx, { entityType: ref.entityType, entityId: ref.entityId,
      previousVersion: material.binding.entityVersion, newVersion: material.binding.entityVersion + 1,
      action: ref.operation, accountingDate: material.binding.accountingDate,
      before: parent(material.observedSources), after: parent(after.observedSources),
      bindingHash: material.bindingHash, protectedEvidenceRef: null, operationId });
    if (row) {
      const consumed = await ctx.sql`
        UPDATE control_operation_approvals SET status='consumed',consumed_at=clock_timestamp(),consumed_effect_id=${effectId}::uuid
        WHERE company_id=${ctx.principal.companyId}::uuid AND id=${row.id}::uuid AND status='approved'
          AND expires_at>clock_timestamp() RETURNING id
      `;
      if (consumed.length !== 1) throw new Error('Approval could not be consumed');
      const { readControlEntityVersion } = await import('./operationVersions');
      const version = await readControlEntityVersion(ctx, { entityType: 'operation_approval', entityId: row.id });
      if (!version) throw new Error('Approval version missing');
      await recordCommittedChange(ctx, { entityType: 'operation_approval', entityId: row.id,
        previousVersion: version.version, newVersion: version.version + 1, action: 'consumed',
        accountingDate: material.binding.accountingDate, before: { status: row.status },
        after: { status: 'consumed', effectId }, bindingHash: material.bindingHash, protectedEvidenceRef: null, operationId });
    }
    return result;
  });
}
