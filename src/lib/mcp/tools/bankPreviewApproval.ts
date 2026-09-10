/**
 * Preview-only companion to the bank allocation tools.
 *
 * A bank allocation is executed against a control INTENT, and that intent is
 * created by the write itself (`prepareBankAllocation`). A preview therefore
 * cannot materialise the operation to ask whether an approval is required — so
 * it asks the kernel's policy question with the amount it already holds, which
 * is the value the binding would carry.
 */
import { controlledOperationApprovalRequiredForAmount } from '@/modules/accounting/services/controls/approvalExecutionService';
import { requireControlTx } from '@/modules/accounting/services/controls/context';
import { findBankTransactionAllocationStates } from '@/modules/accounting/services/bank/bankTransactionLookupService';

export const BANK_APPROVAL_REQUIRED_REASON =
  'an independent approval is required for this allocation — request one with '
  + 'request_operation_approval, then retry';
export const BANK_REVERSAL_APPROVAL_TEXT =
  'An independent approval is required to reverse these allocations. Request one with '
  + 'request_operation_approval, then retry. Nothing was previewed.';

const amountText = (amount: number) => Math.abs(amount).toFixed(2);

/** True when the company's payment policy binds an allocation of this amount. */
export async function bankAllocationApprovalRequired(amount: number,
  operation: 'bank_allocation.post' | 'bank_allocation.reverse'): Promise<boolean> {
  return controlledOperationApprovalRequiredForAmount(requireControlTx(), operation, amountText(amount));
}

export interface BankApprovalPartition<TLine> {
  postable: TLine[];
  skipped: { index: number; transaction_id: string; reason: string }[];
}

/** Splits the lines a preview would otherwise report as posting. */
export async function partitionBankApprovalBound<TLine extends { index: number; txId: string }>(
  companyId: string, lines: readonly TLine[],
): Promise<BankApprovalPartition<TLine>> {
  const partition: BankApprovalPartition<TLine> = { postable: [], skipped: [] };
  if (lines.length === 0) return partition;
  const states = await findBankTransactionAllocationStates(companyId, lines.map((line) => line.txId));
  for (const line of lines) {
    const amount = states.get(line.txId)?.amount ?? 0;
    if (await bankAllocationApprovalRequired(amount, 'bank_allocation.post')) {
      partition.skipped.push({ index: line.index, transaction_id: line.txId, reason: BANK_APPROVAL_REQUIRED_REASON });
    } else partition.postable.push(line);
  }
  return partition;
}
