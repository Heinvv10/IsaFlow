/**
 * The request-shape refusals for supplier allocations, moved out of
 * `supplierAllocationLines` (300-line cap) with one addition: an amount must be
 * a whole number of cents.
 */

import { hasWholeCents } from '@/lib/money/wholeCents';
import { SupplierPaymentRefusal } from './supplierPaymentRefusal';
import type { SupplierAllocationInput } from './supplierAllocationLines';

/** Faults in the REQUEST — checked before any query, naming the offending bill. */
export function assertAllocationShape(allocations: readonly SupplierAllocationInput[]): void {
  if (allocations.length === 0) throw new SupplierPaymentRefusal('Provide at least one allocation.');
  const seen = new Set<string>();
  for (const alloc of allocations) {
    if (!Number.isFinite(alloc.amount) || alloc.amount <= 0) {
      throw new SupplierPaymentRefusal(`Allocation amount for invoice ${alloc.invoiceId} must be a positive number.`);
    }
    // The column is NUMERIC(15,2) and rounds a third decimal half-up, while the guard in `buildLine` and the
    // write in `applyLineToBill` would each see the figure as given: R1.005 against a R1.00 bill stored R1.01
    // paid. The AR twin (`receiptInvoiceLock.assertAllocationShape`) refuses the same shape.
    if (!hasWholeCents(alloc.amount)) {
      throw new SupplierPaymentRefusal(
        `Allocation amount ${alloc.amount} for invoice ${alloc.invoiceId} is not a whole number of cents — amounts are stored to the cent.`,
      );
    }
    if (seen.has(alloc.invoiceId)) {
      // The unique index on (payment_id, invoice_id) would raise 23505 halfway
      // through the write instead — a database error the caller cannot act on,
      // arriving after earlier lines have been written.
      throw new SupplierPaymentRefusal(`Invoice ${alloc.invoiceId} appears more than once in this request.`);
    }
    seen.add(alloc.invoiceId);
  }
}
