/**
 * The approval gate in front of a batch's BANK FILE (R-035 PR5): the EFT file
 * (eft-generate) and the Netcash submission (netcash/submit) are money
 * leaving, and neither checked the batch at all. Enforcement off: unchanged,
 * no lock taken.
 *
 * Under payment_batch enforcement a batch is sent only when (round 1 LOW f)
 * its status says it was approved (approved, or processed — its file may be
 * sent after its journal) and (orchestrator decision) the approval gate clears
 * its current content. The payees' supplier rows are share-locked FIRST
 * (round 1 LOW a): the file is built from their LIVE bank details, so a
 * bank-detail edit in flight is waited for and judged by the gate (stale),
 * rather than slipping between the gate's read and the payee read.
 */

import { sql } from '@/lib/neon';
import { isEnforced } from '../gl/approvalEnforcement';
import { assertApprovalCleared } from '../gl/approvalGate';

/** A batch whose status says nobody approved it, under enforcement. Routes answer 409; raised before any write. */
export class BatchNotSendableError extends Error {
  readonly code = 'BATCH_NOT_SENDABLE';
  constructor(readonly batchStatus: string) {
    super(`Batch is ${batchStatus}, so it cannot be sent to the bank: approve it first.`);
    this.name = 'BatchNotSendableError';
  }
}

/** Throws BatchNotSendableError or ApprovalRequiredError unless the batch may be sent to the bank now. */
export async function assertBatchMayBeSent(companyId: string, batchId: string, batchStatus: string): Promise<void> {
  if (!(await isEnforced(companyId, 'payment_batch'))) return;
  // FOR SHARE, in id order, held to the end of the request: a bank-detail edit
  // (updateSupplier locks the supplier FOR UPDATE) waits for the file, or the
  // file waits for it and the gate then sees the new details.
  await sql`
    SELECT s.id FROM suppliers s
    WHERE s.company_id = ${companyId}::UUID
      AND s.id IN (SELECT sp.supplier_id FROM supplier_payments sp
                   WHERE sp.batch_id = ${batchId}::UUID AND sp.company_id = ${companyId}::UUID)
    ORDER BY s.id
    FOR SHARE
  `;
  if (batchStatus !== 'approved' && batchStatus !== 'processed') throw new BatchNotSendableError(batchStatus);
  await assertApprovalCleared(companyId, 'payment_batch', batchId);
}
