/**
 * Approving a supplier payment batch (draft -> approved) — split from
 * batchPaymentService, which sits at the file-size cap.
 *
 * A batch EFT is ONE approvable document (`payment_batch`, Hein 2026-10-06):
 * its digest covers every member line's payee, the payee's bank details and
 * the amount. Approving it is an instruction to pay (decision Q4), so the
 * approval gate runs here under the batch's row lock, before any write, and
 * again in processBatch where the money moves.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { claimUnderLockTimeout } from '../core/documentClaimLock';
import { assertApprovalCleared } from '../gl/approvalGate';

/**
 * The batch is not a draft when the approve runs — it never was, or a
 * concurrent request approved, processed or cancelled it. Raised before any
 * write, so a route may answer it 409.
 */
export class BatchNotApprovableError extends Error {
  readonly code = 'BATCH_NOT_APPROVABLE';
  constructor(readonly batchStatus: string) {
    super(`Batch is ${batchStatus}, not draft — it cannot be approved.`);
    this.name = 'BatchNotApprovableError';
  }
}

export async function approveBatch(companyId: string, id: string, userId: string): Promise<void> {
  await assertNotImpersonating(); // R-032 L5: first, before any read or write
  // The batch row first, 5s-bounded like processBatch's lock. This used to
  // UPDATE unlocked and ignore the row count, so approving a processed or
  // cancelled batch answered 200 'approved' and changed nothing.
  const locked = await claimUnderLockTimeout('payment batch', async () => (await sql`
    SELECT status FROM supplier_payment_batches
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
    FOR UPDATE
  `) as DbRow[]);
  if (!locked[0]) throw new Error('Batch not found');
  if (String(locked[0].status) !== 'draft') throw new BatchNotApprovableError(String(locked[0].status));
  // R-035 PR5: the gate, under the lock and before the first write.
  await assertApprovalCleared(companyId, 'payment_batch', id);

  const done = (await sql`
    UPDATE supplier_payment_batches SET status = 'approved', updated_at = NOW()
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND status = 'draft'
    RETURNING id
  `) as DbRow[];
  if (done.length === 0) throw new BatchNotApprovableError('changed concurrently');
  // The batch has no approver column; its members do, and carry who approved them.
  await sql`
    UPDATE supplier_payments SET status = 'approved', approved_by = ${userId}::UUID, approved_at = NOW()
    WHERE batch_id = ${id}::UUID AND company_id = ${companyId}::UUID AND status = 'draft'
  `;
  log.info('Approved batch', { id }, 'accounting');
}
