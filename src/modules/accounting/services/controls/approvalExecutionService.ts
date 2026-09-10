import {assertOperationRequester} from './operationRequester';
import { operationPermission,operationRequiresPosting,operationRuleType } from './operationPermissions';
import { randomUUID } from 'node:crypto';
import { withSavepoint } from '@/lib/neon';
import type { ControlTx, OperationRef } from './contracts';
import { assertControlTx } from './context';
import { canonicalJson } from './canonical';
import { approvalAuthorities, approvalDecisions, assertRequesterAuthority, lockApproval, validateDecisions, type ApprovalRow, type AuthorityRow } from './approvalQueries';
import { canonicalOperationRef, loadOperationMaterial, materializeOperation, reserveOperationExposure } from './operationMaterializer';
import { SuppliedApprovalRefusal, isSuppliedApprovalRefusal } from './suppliedApprovalRefusal';
export { isSuppliedApprovalRefusal, SuppliedApprovalRefusal } from './suppliedApprovalRefusal';

import { initializeOperationObservations } from './approvalRequestService';

/**
 * The kernel's refusal when a company policy binds an operation and no approval
 * was supplied. Same message as before, so boundaries that match on it keep
 * working; the code lets the MCP transport answer with what to request.
 */
export class OperationApprovalRequiredError extends Error {
  readonly code = 'OPERATION_APPROVAL_REQUIRED';
  constructor() { super('Independent operation approval is required'); this.name = 'OperationApprovalRequiredError'; }
}
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
/**
 * A caller-supplied approval that cannot be used is the CALLER's error — a
 * wrong id, a rejected decision, material that moved on. Transports answer it
 * as a conflict rather than a server failure; the code is carried by both the
 * live execution and its preview, because they run the same checks.
 */
/**
 * SQLSTATEs the control functions RAISE deliberately (627/628 raise 42501 for
 * an approval outside the caller's company, or a caller who is not a member).
 * A transport fault — a deadlock, a serialization failure, a constraint — keeps
 * its own code and stays a server failure. Nothing else is marked: a plain
 * Error in this region is an integrity or programming failure, not a refusal.
 */
const CONTROL_REFUSAL_SQLSTATES = new Set(['P0001', '42501']);
async function markSuppliedApprovalFailure<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) {
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    if (error instanceof Error && typeof code === 'string' && CONTROL_REFUSAL_SQLSTATES.has(code)) {
      // The SQLSTATE is kept; the marker is what a transport reads. Logged
      // because 42501 also covers a broken request context, which is a server
      // fault wearing a caller error's clothes (see gl/.claude.md).
      Object.assign(error, { suppliedApprovalRefusal: true });
      const { log } = await import('@/lib/logger');
      log.warn('Supplied approval refused by a control function', { sqlstate: code, reason: error.message }, 'controls');
    }
    throw error;
  }
}
export function assertApprovalExecutable(row: ApprovalRow, currentHash: string): void {
  if (row.status !== 'approved' || !row.unexpired) throw new SuppliedApprovalRefusal('Approval is not executable');
  if (row.binding_hash !== currentHash) throw new SuppliedApprovalRefusal('Approval material changed');
}

/**
 * The authority this kernel asserts for an operation, callable on its own by a
 * preview that skips only the write. One owner for the rule: the execution path
 * below calls this too.
 */
export async function assertControlledOperationAuthority(ctx: ControlTx, operation: OperationRef['operation']): Promise<void> {
  const { assertEffectivePermission } = await import('@/lib/auth/effectivePermissions');
  await assertEffectivePermission(ctx, operationPermission(operation,'write'));
  if(operationRequiresPosting(operation)) await assertEffectivePermission(ctx, 'write:post');
}

/**
 * The kernel's own approval-required condition, read-only: a preview that skips
 * the write must still know that this operation would be refused without an
 * independent approval. `loadOperationMaterial` reads; nothing here writes.
 */
export async function controlledOperationApprovalRequired(ctx: ControlTx, input: OperationRef): Promise<boolean> {
  assertControlTx(ctx);
  const material = await loadOperationMaterial(ctx, canonicalOperationRef(input));
  return material.binding.policies.length > 0;
}

/**
 * What a preview learns about the approval question.
 *
 * `answered` is the kernel's own verdict. `unavailable` means the operation
 * could not be materialised AT ALL — no calculation receipt, no covering fiscal
 * period, a currency the ledger cannot bind — which is not an approval problem
 * and must not be reported as one. The caller still needs to know whether a
 * policy exists, because a preview that cannot ask must not answer "no approval
 * needed" either.
 */
export type PreviewApprovalAnswer =
  | { kind: 'answered'; required: boolean }
  | { kind: 'unavailable'; policiesExist: boolean };

/** Preview-safe form: the material question runs in its own savepoint. */
export async function controlledOperationApprovalRequiredForPreview(ctx: ControlTx, input: OperationRef): Promise<PreviewApprovalAnswer> {
  assertControlTx(ctx);
  const ref = canonicalOperationRef(input);
  const { loadApprovalRules } = await import('./approvalRuleService');
  try {
    return { kind: 'answered', required: await withSavepoint('preview_approval_question', () => controlledOperationApprovalRequired(ctx, ref)) };
  } catch (error) {
    // Logged, never swallowed silently: this is the only record of why a
    // preview could not be answered, and the reply deliberately does not carry
    // the domain message.
    const { log } = await import('@/lib/logger');
    log.warn('Preview approval question unavailable', { operation: ref.operation, entityType: ref.entityType,
      reason: error instanceof Error ? error.message : String(error) }, 'controls');
    return { kind: 'unavailable', policiesExist: (await loadApprovalRules(ctx, operationRuleType(ref.operation))).length > 0 };
  }
}

/**
 * For a preview whose operation acts on a row the write itself creates — a bank
 * allocation intent exists only after `prepareBankAllocation` — so the same
 * policy rules are matched against the amount the preview already holds. An
 * aggregate-window policy depends on exposure only the write establishes, so it
 * counts as required rather than being guessed at.
 */
export async function controlledOperationApprovalRequiredForAmount(ctx: ControlTx,
  operation: OperationRef['operation'], amount: string): Promise<boolean> {
  assertControlTx(ctx);
  const { loadApprovalRules, matchApprovalRules } = await import('./approvalRuleService');
  const rules = await loadApprovalRules(ctx, operationRuleType(operation));
  if (rules.some(rule => rule.aggregate_window_days !== null)) return true;
  return matchApprovalRules(rules, amount, new Map()).length > 0;
}

/**
 * The one lock order for a supplied approval, shared by the live execution and
 * its preview so the two cannot drift: the tenant's control-policy lock first,
 * then the approval row FOR UPDATE, then the requester, authority and decision
 * checks. Taking the approval first would deadlock (40P01) against a live
 * execution of the same approval that already holds the policy lock. Locks and
 * reads only; both locks end with the transaction.
 */
async function lockPolicyThenApproval(ctx: ControlTx, ref: OperationRef, approvalId: string, authorities: AuthorityRow[]): Promise<ApprovalRow>;
async function lockPolicyThenApproval(ctx: ControlTx, ref: OperationRef, approvalId: string | null, authorities: AuthorityRow[]): Promise<ApprovalRow | null>;
async function lockPolicyThenApproval(ctx: ControlTx, ref: OperationRef, approvalId: string | null, authorities: AuthorityRow[]): Promise<ApprovalRow | null> {
  await ctx.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`control-policy:${ctx.principal.companyId}`},0))`;
  if (!approvalId) return null;
  return markSuppliedApprovalFailure(async () => {
    const row = await lockApproval(ctx, approvalId);
    await assertOperationRequester(ctx, ref, row.requester_person_id);
    await assertRequesterAuthority(row, authorities);
    await validateDecisions(ctx, row, await approvalDecisions(ctx, row.id), authorities);
    return row;
  });
}

/**
 * A preview given an approval must accept it exactly when the live call would:
 * the same requester, authority, decision and binding checks the execution
 * path runs below, in the same lock order and its own savepoint, executing
 * nothing. Throws as the live path throws.
 */
export async function assertSuppliedApprovalExecutable(ctx: ControlTx, input: OperationRef, approvalId: string): Promise<void> {
  assertControlTx(ctx);
  const ref = canonicalOperationRef(input);
  await withSavepoint('preview_supplied_approval', async () => {
    // Inside the savepoint: these functions RAISE, and an error outside one
    // aborts the whole request transaction, so a refusal the caller could act
    // on would come back as a failed commit instead.
    const authorities = await markSuppliedApprovalFailure(() => approvalAuthorities(ctx, approvalId));
    const row = await lockPolicyThenApproval(ctx, ref, approvalId, authorities);
    const bindingHash = (await loadOperationMaterial(ctx, ref)).bindingHash;
    await markSuppliedApprovalFailure(async () => assertApprovalExecutable(row, bindingHash));
  });
}

/** Kernel only: owning domain services must call this before their financial effect. */
export async function executeControlledOperation<T>(ctx: ControlTx, input: OperationRef, approvalId: string | null,
  effect: (permit: ControlledEffectPermit) => Promise<T>): Promise<T> {
  assertControlTx(ctx);
  if (executing.has(ctx.principal)) throw new Error('Nested execution requires the parent effect permit');
  const ref = canonicalOperationRef(input);
  await assertControlledOperationAuthority(ctx, ref.operation);
  return withSavepoint('controlled_ap_operation', async () => {
    // Inside the savepoint for the same reason as the preview above: a raising
    // authority lookup outside one aborts the caller's whole transaction.
    const authorities = approvalId ? await markSuppliedApprovalFailure(() => approvalAuthorities(ctx, approvalId)) : [];
    // Preserve policy-before-approval lock order, including replay lookups.
    const row = await lockPolicyThenApproval(ctx, ref, approvalId, authorities);
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
    if (material.binding.policies.length && !row) throw new OperationApprovalRequiredError();
    if (row) await markSuppliedApprovalFailure(async () => assertApprovalExecutable(row, material.bindingHash));
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
