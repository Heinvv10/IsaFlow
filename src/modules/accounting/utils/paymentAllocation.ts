/**
 * PRD-060: FibreFlow Accounting Module
 * Payment Allocation Validation
 *
 * Validates that payment allocations across invoices are correct:
 * - No overpayment per invoice
 * - Total allocations don't exceed payment amount
 * - No duplicate invoice allocations
 * - All referenced invoices exist
 */

import type {
  PaymentAllocationInput,
  PaymentAllocationResult,
  InvoiceForAllocation,
} from '../types/ap.types';

/**
 * Validate payment allocations against invoices.
 */
export function validatePaymentAllocations(
  paymentAmount: number,
  allocations: PaymentAllocationInput[],
  invoices: InvoiceForAllocation[]
): PaymentAllocationResult {
  const errors: string[] = [];
  const invoiceMap = new Map(invoices.map(inv => [inv.id, inv]));
  const resultAllocations: PaymentAllocationResult['allocations'] = [];

  // Check for duplicate invoice IDs
  const invoiceIds = allocations.map(a => a.invoiceId);
  const duplicates = invoiceIds.filter((id, i) => invoiceIds.indexOf(id) !== i);
  if (duplicates.length > 0) {
    errors.push(`Duplicate invoice allocations: ${duplicates.join(', ')}`);
    return {
      valid: false,
      allocations: [],
      totalAllocated: 0,
      unallocated: paymentAmount,
      errors,
    };
  }

  let totalAllocated = 0;

  for (const alloc of allocations) {
    // Validate amount is positive
    if (alloc.amount <= 0) {
      errors.push(`Allocation amount must be positive (invoice: ${alloc.invoiceId}, amount: ${alloc.amount})`);
      continue;
    }

    // Validate invoice exists
    const invoice = invoiceMap.get(alloc.invoiceId);
    if (!invoice) {
      errors.push(`Invoice not found: ${alloc.invoiceId}`);
      continue;
    }

    // Validate doesn't exceed invoice balance
    if (alloc.amount > invoice.balance) {
      errors.push(
        `Allocation R${alloc.amount.toFixed(2)} exceeds invoice ${invoice.invoiceNumber} balance of R${invoice.balance.toFixed(2)}`
      );
      continue;
    }

    const newBalance = Math.round((invoice.balance - alloc.amount) * 100) / 100;

    resultAllocations.push({
      invoiceId: alloc.invoiceId,
      amount: alloc.amount,
      newBalance,
      fullyPaid: newBalance === 0,
    });

    totalAllocated += alloc.amount;
  }

  // Check total allocations don't exceed payment amount
  totalAllocated = Math.round(totalAllocated * 100) / 100;
  if (totalAllocated > paymentAmount) {
    errors.push(
      `Total allocations R${totalAllocated.toFixed(2)} exceed payment amount R${paymentAmount.toFixed(2)}`
    );
  }

  const unallocated = Math.round((paymentAmount - totalAllocated) * 100) / 100;

  return {
    valid: errors.length === 0,
    allocations: resultAllocations,
    totalAllocated,
    unallocated: Math.max(0, unallocated),
    errors,
  };
}
