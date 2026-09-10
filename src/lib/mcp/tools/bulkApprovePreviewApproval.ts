/**
 * Preview-only companion to the bulk approve runner.
 *
 * The control kernel refuses an operation whose company policy demands an
 * independent approval. A preview that skipped that question reported the
 * document as one that would post, which is the opposite of what the live call
 * does with it — so the preview asks the kernel the same question, read-only,
 * and reports the document as skipped with the reason instead.
 */
import { controlledOperationApprovalRequiredForPreview } from '@/modules/accounting/services/controls/approvalExecutionService';
import { requireControlTx } from '@/modules/accounting/services/controls/context';
import { approvalRequiredReason } from '../approvalReply';
import type { OperationRef } from '@/modules/accounting/services/controls/contracts';

/** None of the bulk-approve tools accepts approval_id; see approvalReply.ts. */
export const APPROVAL_REQUIRED_REASON = approvalRequiredReason('bulk_approve');
/** Deliberately not an approval instruction: something else stopped the question. */
export const APPROVAL_UNKNOWN_REASON =
  'could not be previewed — this document\'s posting material could not be built; an '
  + 'independent approval may also be required';

export interface ApprovalPartition {
  postable: { index: number; id: string }[];
  skipped: { index: number; document_id: string; reason: string }[];
}

/** Never called on the live path: there the kernel refuses the batch itself. */
export async function partitionApprovalBound(
  candidates: readonly { index: number; id: string }[],
  ref: { entityType: string; operation: OperationRef['operation']; toolName?: string },
): Promise<ApprovalPartition> {
  const partition: ApprovalPartition = { postable: [], skipped: [] };
  for (const candidate of candidates) {
    const answer = await controlledOperationApprovalRequiredForPreview(requireControlTx(),
      { entityType: ref.entityType, entityId: candidate.id, operation: ref.operation });
    const reason = answer.kind === 'answered'
      ? (answer.required ? (ref.toolName ? approvalRequiredReason(ref.toolName) : APPROVAL_REQUIRED_REASON) : null)
      // No policy binds it, so nothing is being withheld: leave the document to
      // the rest of the partition, which reports its own reasons.
      : (answer.policiesExist ? APPROVAL_UNKNOWN_REASON : null);
    if (reason) partition.skipped.push({ index: candidate.index, document_id: candidate.id, reason });
    else partition.postable.push(candidate);
  }
  return partition;
}
