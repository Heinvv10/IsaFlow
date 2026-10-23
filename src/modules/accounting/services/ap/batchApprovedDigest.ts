/**
 * What an approved supplier payment batch was approved FOR (migration 922).
 *
 * approveBatch stores the batch's `payment_batch` digest — approval_document_digest(),
 * the one the approval gate compares (gl/approvalDocuments): every member's payee, the
 * payee's bank details and the amount — in `approved_digest`. The bank file, the Netcash
 * send and process compare it with the current digest and refuse a batch whose content
 * changed since, WHATEVER the payment_batch enforcement switch says: with enforcement
 * off, nothing else stood between an approval and money paid to bank details nobody
 * approved. The way out is re-approving the batch (approveBatch).
 *
 * A batch approved before migration 922 has no stored digest: allowed, with a warning
 * (Hein, 2026-10-23 — no backfill; today's digest is not evidence of what was approved).
 *
 * Call with the batch row already locked by this transaction. The payees are
 * share-locked here, in id order (batch → supplier, the #789 lock order): a bank-detail
 * edit (updateSupplier locks the supplier FOR UPDATE) in flight is waited for and then
 * seen by the compare, or waits for this request to end.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { resolveApprovalDocument } from '../gl/approvalDocuments';

/** The batch's content changed since it was approved. Raised before any write; routes answer 409. */
export class BatchChangedSinceApprovalError extends Error {
  readonly code = 'BATCH_CHANGED_SINCE_APPROVAL';
  constructor(readonly batchId: string) {
    super('This batch changed after it was approved (a payee, their bank details or an amount), '
      + 'so it cannot be paid as it stands. Check the batch and re-approve it.');
    this.name = 'BatchChangedSinceApprovalError';
  }
}

/** FOR SHARE on the batch's payees, in id order, held to the end of the transaction. */
export async function lockBatchPayees(companyId: string, batchId: string): Promise<void> {
  await sql`
    SELECT s.id FROM suppliers s
    WHERE s.company_id = ${companyId}::UUID
      AND s.id IN (SELECT sp.supplier_id FROM supplier_payments sp
                   WHERE sp.batch_id = ${batchId}::UUID AND sp.company_id = ${companyId}::UUID)
    ORDER BY s.id
    FOR SHARE
  `;
}

/** The batch's digest now: the approval gate's own definition. */
export async function currentBatchDigest(companyId: string, batchId: string): Promise<string | null> {
  return (await resolveApprovalDocument(companyId, 'payment_batch', batchId)).digest;
}

/** The stored approval digest; null when the batch was never approved under migration 922. */
async function approvedDigest(companyId: string, batchId: string): Promise<string | null> {
  const rows = (await sql`
    SELECT approved_digest FROM supplier_payment_batches
    WHERE id = ${batchId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  return rows[0]?.approved_digest != null ? String(rows[0].approved_digest) : null;
}

/**
 * True when the batch was approved with a stored digest that is no longer its content.
 * A read for display (the batch page): takes no lock, raises nothing.
 */
export async function batchChangedSinceApproval(companyId: string, batchId: string): Promise<boolean> {
  const approved = await approvedDigest(companyId, batchId);
  if (approved === null) return false;
  return (await currentBatchDigest(companyId, batchId)) !== approved;
}

/**
 * Share-locks the payees, then throws BatchChangedSinceApprovalError when the batch's
 * current digest is not the one it was approved with. A legacy batch (no stored digest)
 * passes with a warning. The caller holds the batch row lock and has checked its status.
 */
export async function assertBatchUnchangedSinceApproval(companyId: string, batchId: string): Promise<void> {
  await lockBatchPayees(companyId, batchId);
  const approved = await approvedDigest(companyId, batchId);
  if (approved === null) {
    log.warn('Approved batch has no stored approval digest (approved before migration 922): content not compared',
      { batchId }, 'accounting');
    return;
  }
  if ((await currentBatchDigest(companyId, batchId)) !== approved) throw new BatchChangedSinceApprovalError(batchId);
}
