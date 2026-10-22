/**
 * The approval gate in front of a batch's BANK FILE (R-035 PR5): the EFT file
 * (eft-generate) and the Netcash submission (netcash/submit) are money
 * leaving, and neither checked the batch at all. Enforcement off: no lock
 * taken, but a batch is still sent only once its status says it was approved
 * (approved, or processed — its file may be sent after its journal): a draft,
 * cancelled or reversed batch is refused whatever the switch says (AP-10, and
 * the draft-batch export defect).
 *
 * Under payment_batch enforcement (orchestrator decision) the approval gate
 * must also clear the batch's current content. The payees' supplier rows are
 * share-locked FIRST (round 1 LOW a): the file is built from their LIVE bank
 * details, so a bank-detail edit in flight is waited for and judged by the
 * gate (stale), rather than slipping between the gate's read and the payee read.
 */

import { sql } from '@/lib/neon';
import { isEnforced } from '../gl/approvalEnforcement';
import { assertApprovalCleared } from '../gl/approvalGate';

/** Statuses of a batch that was called off: never sent, whatever the enforcement switch says. */
const DEAD_STATUSES: ReadonlySet<string> = new Set(['cancelled', 'reversed']);

/** The statuses a batch may be sent from: approved, or processed (its file may follow its journal). */
const SENDABLE_STATUSES: ReadonlySet<string> = new Set(['approved', 'processed']);

/** A batch whose status says it was not approved, or was called off. Routes answer 409; raised before any write. */
export class BatchNotSendableError extends Error {
  readonly code = 'BATCH_NOT_SENDABLE';
  constructor(readonly batchStatus: string) {
    super(DEAD_STATUSES.has(batchStatus)
      ? `Batch is ${batchStatus}, so it cannot be sent to the bank.`
      : `Batch is ${batchStatus}, so it cannot be sent to the bank: approve it first.`);
    this.name = 'BatchNotSendableError';
  }
}

/** Throws BatchNotSendableError or ApprovalRequiredError unless the batch may be sent to the bank now. */
export async function assertBatchMayBeSent(companyId: string, batchId: string, batchStatus: string): Promise<void> {
  // Before the enforcement early-return, on the status the caller read under its batch lock (eft-generate: FOR NO KEY
  // UPDATE, netcash/submit: FOR SHARE), so approve / cancel cannot move it before the file is built or sent.
  // AP-10: a cancelled batch's payments are cancelled and its bills freed; a reversed one was paid and its journal
  // undone — sending either to the bank pays money no ledger records. A draft was never approved by anyone: with
  // enforcement off no approval gate stands behind it, so its status is the only evidence it may be paid.
  if (!SENDABLE_STATUSES.has(batchStatus)) throw new BatchNotSendableError(batchStatus);
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
  await assertApprovalCleared(companyId, 'payment_batch', batchId);
}
