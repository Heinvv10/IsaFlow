/**
 * What an approved supplier payment batch was approved FOR (migration 922).
 *
 * approveBatch stores the batch's `payment_batch` digest — approval_document_digest(),
 * the one the approval gate compares (gl/approvalDocuments): every member's payee, the
 * payee's bank details and name (upper(btrim() COLLATE "C"), migration 923), the amount, and the
 * paying account's number and branch (923) — in `approved_digest`. The bank file, the Netcash
 * send and process compare it with the current digest and refuse a batch whose content
 * changed since, WHATEVER the payment_batch enforcement switch says: with enforcement
 * off, nothing else stood between an approval and money paid to bank details nobody
 * approved. The way out is re-approving the batch (approveBatch).
 *
 * A batch approved before migration 922 has no stored digest: allowed, with a warning
 * (Hein, 2026-10-23 — no backfill; today's digest is not evidence of what was approved).
 *
 * Call with the batch row already locked by this transaction. The payees are
 * share-locked here, in id order (batch → supplier, the #789 lock order), then the
 * paying account (→ gl_accounts): a bank-detail edit or rename (updateSupplier locks the
 * supplier FOR UPDATE) or an edit of the paying account in flight is waited for and then
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
    super('This batch changed after it was approved (a payee, their name or bank details, an amount, '
      + 'or the paying account), so it cannot be paid as it stands. Check the batch and re-approve it.');
    this.name = 'BatchChangedSinceApprovalError';
  }
}

/**
 * An approve named content (the `expectedDigest` the batch page read with the payments it showed) that is not the
 * batch's content now — or a RE-approve named none. Raised before any write; routes answer 409. The decide flow of
 * approval requests binds an approver to what they saw the same way (expectedDigest).
 */
export class BatchContentNotAsShownError extends Error {
  readonly code = 'BATCH_CONTENT_NOT_AS_SHOWN';
  constructor(readonly batchId: string) {
    super('This batch is not what the page showed you - it changed while you were looking at it. '
      + 'Reload it, check the payments, and approve again.');
    this.name = 'BatchContentNotAsShownError';
  }
}

/** FOR SHARE on the batch's payees, in id order, then on its paying account; held to the end of the transaction. */
export async function lockBatchPayees(companyId: string, batchId: string): Promise<void> {
  await sql`
    SELECT s.id FROM suppliers s
    WHERE s.company_id = ${companyId}::UUID
      AND s.id IN (SELECT sp.supplier_id FROM supplier_payments sp
                   WHERE sp.batch_id = ${batchId}::UUID AND sp.company_id = ${companyId}::UUID)
    ORDER BY s.id
    FOR SHARE
  `;
  await sql`
    SELECT ga.id FROM gl_accounts ga
    WHERE ga.company_id = ${companyId}::UUID
      AND ga.id = (SELECT b.bank_account_id FROM supplier_payment_batches b
                   WHERE b.id = ${batchId}::UUID AND b.company_id = ${companyId}::UUID)
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
