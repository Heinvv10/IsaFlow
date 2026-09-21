/**
 * The K-063/K-064/K-066 gates on a SINGLE supplier payment's two money-moving
 * actions, kept out of `supplierPaymentWorkflowService` (already over the
 * file-size cap on master). The caller holds the payment row lock.
 *
 * One rule runs through both: a BATCH MEMBER moves money only through its
 * batch. `processBatch` posts one journal for the batch total and applies every
 * member's allocations, so processing a member on its own debited AP twice, and
 * voiding a processed member rolled its bill back while the batch journal's AP
 * debit stood — the bill read unpaid and took a second payment.
 */

import { assertAllocationsStillAllocatable } from './supplierBatchAllocationPlan';
import { voidUnprocessedPayment } from './supplierPaymentCancel';
import { SupplierPaymentRefusal } from './supplierPaymentRefusal';
import type { SupplierPayment } from '../../types/ap.types';

function refuseBatchMember(payment: SupplierPayment, action: 'process' | 'void'): void {
  if (!payment.batchId) return;
  const where = action === 'process'
    ? 'process it through its batch.'
    : payment.status === 'processed'
      ? 'it was paid by that batch; reverse the batch.'
      : 'cancel it through its batch.';
  throw new SupplierPaymentRefusal(`Payment ${payment.paymentNumber} belongs to batch ${payment.batchId} — ${where}`);
}

/** Process: not a batch member, and every bill STILL payable and this supplier's. */
export async function assertPaymentStillProcessable(companyId: string, payment: SupplierPayment): Promise<void> {
  refuseBatchMember(payment, 'process');
  // Ascending bill id — the order `fetchBillCandidates` locks in.
  const allocations = [...(payment.allocations ?? [])].sort((a, b) => (a.invoiceId < b.invoiceId ? -1 : 1));
  await assertAllocationsStillAllocatable(companyId, allocations.map((a) => ({
    invoiceId: a.invoiceId, amount: a.amountAllocated, supplierId: payment.supplierId,
  })));
}

/**
 * Void: refuse what may not be voided here; void a draft/approved payment as a
 * status change (it moved nothing) and answer true; answer false for a
 * processed payment, whose journal the caller reverses.
 */
export async function voidIfUnprocessed(companyId: string, payment: SupplierPayment): Promise<boolean> {
  refuseBatchMember(payment, 'void');
  if (payment.status === 'draft' || payment.status === 'approved') {
    await voidUnprocessedPayment(companyId, payment);
    return true;
  }
  // On a SUPPLIER PAYMENT 'reconciled' means FULLY APPLIED to its bills
  // (`supplierPaymentApplicationService` sets it when nothing is left
  // unapplied), not bank-reconciled — so it is voided like 'processed'. What the
  // old refusal meant to protect, cash on a completed bank reconciliation, is
  // refused by the bank line's own state (`paymentJournalReversal.ts`).
  if (payment.status !== 'processed' && payment.status !== 'reconciled') {
    throw new SupplierPaymentRefusal(`Only draft, approved, processed or fully applied payments can be voided (status: ${payment.status})`);
  }
  return false;
}
