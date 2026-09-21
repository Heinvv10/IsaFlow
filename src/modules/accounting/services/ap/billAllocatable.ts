/**
 * Whether a bill may take a supplier payment at all — the gate every AP
 * allocation path shares: `planSupplierAllocationLines` (bank line, payment
 * application, batch creation) and `createSupplierPayment`.
 */

import { BALANCE_DERIVED } from '../ar/invoiceStatusRecompute';
import { SupplierPaymentRefusal } from './supplierPaymentRefusal';

/**
 * Statuses a bill may be in to take a payment — an ALLOW-list, deliberately.
 *
 * The deny-list this replaced named 'cancelled' and 'draft' only, so
 * 'pending_approval' and 'disputed' passed. AP is credited only by
 * `approveSupplierInvoice`, so such a bill has no journal: the payment's DR
 * Accounts Payable had no matching credit, and `recomputeInvoiceStatus` left
 * the status alone, so the bill read unapproved and fully paid at once. It is
 * the SAME set the recompute acts on, so a status added later fails closed.
 */
const ALLOCATABLE_STATUSES = new Set(BALANCE_DERIVED);

/**
 * The two facts that decide whether ANY payment may touch a bill: its status
 * and whose bill it is. `createSupplierPayment` runs its own bill query and
 * calls this so it refuses on the same terms.
 */
export function assertBillAllocatable(
  bill: { invoiceNumber: string; status: string; supplierId: string },
  expectedSupplierId: string,
): void {
  if (!ALLOCATABLE_STATUSES.has(bill.status)) {
    throw new SupplierPaymentRefusal(
      `Invoice ${bill.invoiceNumber} is ${bill.status} and cannot receive a payment.`,
    );
  }
  if (bill.supplierId !== expectedSupplierId) {
    throw new SupplierPaymentRefusal(
      `Invoice ${bill.invoiceNumber} belongs to a different supplier than this payment.`,
    );
  }
}
