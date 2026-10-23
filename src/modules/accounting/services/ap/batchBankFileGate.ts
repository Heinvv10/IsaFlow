/**
 * The approval gate in front of a batch's BANK FILE (R-035 PR5): the EFT file
 * (eft-generate) and the Netcash submission (netcash/submit) are money
 * leaving, and neither checked the batch at all. Enforcement off: a batch
 * is still sent only once its status says it was approved
 * (approved, or processed — its file may be sent after its journal): a draft,
 * cancelled or reversed batch is refused whatever the switch says (AP-10, and
 * the draft-batch export defect).
 *
 * Under payment_batch enforcement (orchestrator decision) the approval gate
 * must also clear the batch's current content. Either way the payees' supplier
 * rows are share-locked FIRST (round 1 LOW a): the file is built from their LIVE bank
 * details, so a bank-detail edit in flight is waited for and judged by the
 * gate (stale), rather than slipping between the gate's read and the payee read.
 *
 * Enforcement on or off, an approved or processed batch whose content changed since it
 * was approved (its stored digest, migration 922) is refused: BatchChangedSinceApprovalError
 * (ap/batchApprovedDigest) — after the approval gate when it is enforced, so the gate's
 * own answer (APPROVAL_STALE) still comes first.
 */

import { assertBatchUnchangedSinceApproval, lockBatchPayees } from './batchApprovedDigest';
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

/** Throws BatchNotSendableError, BatchChangedSinceApprovalError or ApprovalRequiredError unless the batch may be sent to the bank now. */
export async function assertBatchMayBeSent(companyId: string, batchId: string, batchStatus: string): Promise<void> {
  // Whatever the enforcement switch says, on the status the caller read under its batch lock (eft-generate: FOR NO KEY
  // UPDATE, netcash/submit: FOR SHARE), so approve / cancel cannot move it before the file is built or sent.
  // AP-10: a cancelled batch's payments are cancelled and its bills freed; a reversed one was paid and its journal
  // undone — sending either to the bank pays money no ledger records. A draft was never approved by anyone: with
  // enforcement off no approval gate stands behind it, so its status is the only evidence it may be paid.
  if (!SENDABLE_STATUSES.has(batchStatus)) throw new BatchNotSendableError(batchStatus);
  // The payees are share-locked FIRST, in id order, held to the end of the request, enforcement on or off: a
  // bank-detail edit (updateSupplier locks the supplier FOR UPDATE) waits for the file, or the file waits for it and
  // the gate and the compare below see the new details.
  await lockBatchPayees(companyId, batchId);
  // Under enforcement the gate answers first, as it always has (APPROVAL_STALE for changed content).
  if (await isEnforced(companyId, 'payment_batch')) await assertApprovalCleared(companyId, 'payment_batch', batchId);
  // Then, enforcement on or off: the content the batch digest covers is what was approved (migration 922) — its
  // payees, their bank details, the amounts; not the supplier NAME the file carries as beneficiary. A processed batch
  // is compared too: its file is still built from the payees' live bank details.
  await assertBatchUnchangedSinceApproval(companyId, batchId);
}
