/**
 * bulk_approve_credit_notes' dry run foresees the proportional-VAT refusal (ar/creditNoteTypedSplit) the live run
 * meets at approve: a customer note linked to a TYPED invoice must credit no more than the invoice has left and carry
 * exactly requiredCreditNoteVat on its remaining net and VAT. Judged in the live posting order, each invoice's state
 * moved by the notes of the batch before it: their own credit AND what their approvals APPLY (the linked invoice, then
 * the FIFO walk with auto_apply 'fifo'), so a standalone note settling a typed invoice first is foreseen (#1701 round 8:
 * shared/creditNoteBatchSimulation). Reads only.
 */
import { simulateBatchApprovals } from '@/modules/accounting/services/shared/creditNoteBatchSimulation';
import type { CreditNoteAutoApply } from '@/modules/accounting/services/shared/creditNoteFifo';

/** id -> `vat_split_refused: <why>` for each note (in `orderedIds`, the live order) the live run would refuse. */
export async function proportionalVatRefusals(companyId: string, orderedIds: readonly string[], autoApply: CreditNoteAutoApply = 'fifo'):
  Promise<Map<string, string>> {
  return simulateBatchApprovals(companyId, orderedIds, autoApply);
}
