/**
 * Preview-only companion to the bulk approve runner.
 *
 * The control kernel refuses an operation whose company policy demands an
 * independent approval. A preview that skipped that question reported the
 * document as one that would post, which is the opposite of what the live call
 * does with it — so the preview asks the kernel the same question, read-only,
 * and reports the document as skipped with the reason instead.
 */
import { controlledOperationApprovalRequired } from '@/modules/accounting/services/controls/approvalExecutionService';
import { requireControlTx } from '@/modules/accounting/services/controls/context';
import type { OperationRef } from '@/modules/accounting/services/controls/contracts';

export const APPROVAL_REQUIRED_REASON =
  'an independent approval is required for this operation — request one with '
  + 'request_operation_approval, then retry';

export interface ApprovalPartition {
  postable: { index: number; id: string }[];
  skipped: { index: number; document_id: string; reason: string }[];
}

/** Never called on the live path: there the kernel refuses the batch itself. */
export async function partitionApprovalBound(
  candidates: readonly { index: number; id: string }[],
  ref: { entityType: string; operation: OperationRef['operation'] },
): Promise<ApprovalPartition> {
  const partition: ApprovalPartition = { postable: [], skipped: [] };
  for (const candidate of candidates) {
    const required = await controlledOperationApprovalRequired(requireControlTx(),
      { entityType: ref.entityType, entityId: candidate.id, operation: ref.operation });
    if (required) {
      partition.skipped.push({ index: candidate.index, document_id: candidate.id, reason: APPROVAL_REQUIRED_REASON });
    } else partition.postable.push(candidate);
  }
  return partition;
}
