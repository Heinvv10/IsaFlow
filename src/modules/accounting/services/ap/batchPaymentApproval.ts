/**
 * Approving a supplier payment batch (draft -> approved) — split from
 * batchPaymentService, which sits at the file-size cap.
 *
 * A batch EFT is ONE approvable document (`payment_batch`, Hein 2026-10-06):
 * its digest covers every member line's payee, the payee's bank details and
 * the amount. Approving it is an instruction to pay (decision Q4), so the
 * approval gate runs here under the batch's row lock, before any write, and
 * again in processBatch where the money moves.
 *
 * What was approved is stored (`approved_digest`, migration 922), enforcement on or
 * off, so the bank file, the Netcash send and process can refuse a batch that changed
 * since (ap/batchApprovedDigest); re-approving is the way out.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { claimUnderLockTimeout } from '../core/documentClaimLock';
import { assertApprovalCleared } from '../gl/approvalGate';
import { logAuditOrThrow } from '../core/auditTrailService';
import { currentBatchDigest, lockBatchPayees } from './batchApprovedDigest';

/**
 * The batch is not a draft when the approve runs — it never was, or a
 * concurrent request approved, processed or cancelled it — or it is an approved
 * or processed batch with nothing to re-approve. Raised before any write, so a
 * route may answer it 409.
 */
export class BatchNotApprovableError extends Error {
  readonly code = 'BATCH_NOT_APPROVABLE';
  constructor(readonly batchStatus: string) {
    super(batchStatus === 'approved' || batchStatus === 'processed'
      ? `Batch is ${batchStatus} and unchanged since its approval — there is nothing to re-approve.`
      : `Batch is ${batchStatus}, not draft — it cannot be approved.`);
    this.name = 'BatchNotApprovableError';
  }
}

/** A draft is approved; an approved or processed batch may only be RE-approved, once its content changed. */
const APPROVABLE: ReadonlySet<string> = new Set(['draft', 'approved', 'processed']);

/**
 * Approves a draft batch, or RE-approves an approved or processed one whose content
 * changed since its approval (migration 922: its stored digest is no longer its current
 * one) — a processed batch's file is still built from its payees' live bank details, so
 * without this it could never be sent. A re-approval leaves the status as it is. Either
 * way the digest approved is stored in the same UPDATE, and the members carry the
 * approver. An approved or processed batch that has not changed — or that has no stored
 * digest — is refused BatchNotApprovableError, as before.
 */
export async function approveBatch(companyId: string, id: string, userId: string): Promise<void> {
  await assertNotImpersonating(); // R-032 L5: first, before any read or write
  // The batch row first, 5s-bounded like processBatch's lock. This used to
  // UPDATE unlocked and ignore the row count, so approving a processed or
  // cancelled batch answered 200 'approved' and changed nothing.
  const locked = await claimUnderLockTimeout('payment batch', async () => (await sql`
    SELECT status, approved_digest FROM supplier_payment_batches
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    FOR UPDATE
  `) as DbRow[]);
  if (!locked[0]) throw new Error('Batch not found');
  const status = String(locked[0].status);
  const previous = locked[0].approved_digest != null ? String(locked[0].approved_digest) : null;
  if (!APPROVABLE.has(status)) throw new BatchNotApprovableError(status);
  // Then the payees, in id order (batch → supplier, as the bank-file gate): the digest
  // stored below is of bank details no edit can change before this transaction ends.
  await lockBatchPayees(companyId, id);
  const digest = await currentBatchDigest(companyId, id);
  const reapproval = status !== 'draft';
  if (reapproval && (previous === null || previous === digest)) throw new BatchNotApprovableError(status);
  // R-035 PR5: the gate, under the locks and before the first write.
  await assertApprovalCleared(companyId, 'payment_batch', id);

  // A re-approval leaves the status as it is; the digest is stored either way.
  const done = (await sql`
    UPDATE supplier_payment_batches SET status = ${reapproval ? status : 'approved'}, approved_digest = ${digest}, updated_at = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND status = ${status}
    RETURNING id
  `) as DbRow[];
  if (done.length === 0) throw new BatchNotApprovableError('changed concurrently');
  // The batch has no approver column; its members do, and carry who approved them (a
  // re-approval moves them to its approver: they vouch for the content paid now).
  if (!reapproval) {
    await sql`
      UPDATE supplier_payments SET status = 'approved', approved_by = ${userId}::UUID, approved_at = NOW()
      WHERE batch_id = ${id}::UUID AND company_id = ${companyId}::UUID AND status = 'draft'
    `;
    log.info('Approved batch', { id }, 'accounting');
    return;
  }
  // Re-approval: every member still paid by the batch, its status left as it is.
  await sql`
    UPDATE supplier_payments SET approved_by = ${userId}::UUID, approved_at = NOW()
    WHERE batch_id = ${id}::UUID AND company_id = ${companyId}::UUID AND status IS DISTINCT FROM 'cancelled'
  `;
  await logAuditOrThrow({
    companyId, userId, action: 'approve', entityType: 'supplier_payment_batch', entityId: id,
    changes: { fields: [{ field: 'approved_digest', old: previous, new: digest, label: 'Approved content' }],
      metadata: { reapproved: 'true', status } },
  });
  log.info('Re-approved batch whose content changed since its approval', { id }, 'accounting');
}
