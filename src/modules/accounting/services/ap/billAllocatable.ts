/**
 * Whether a bill may take a supplier payment at all — the gate every AP
 * allocation path shares: `planSupplierAllocationLines` (bank line, payment
 * application, batch creation) and `createSupplierPayment`.
 */

import { BALANCE_DERIVED } from '../ar/invoiceStatusRecompute';
import { SupplierPaymentRefusal } from './supplierPaymentRefusal';
import { assertSettleableCurrency, DocumentCurrencyError, loadCompanyCurrency } from '../shared/documentCurrency';

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
  bill: { invoiceNumber: string; status: string; supplierId: string; deleted: boolean },
  expectedSupplierId: string,
): void {
  // A soft-delete reverses the approval journal but leaves `status` alone, so
  // a deleted 'approved' bill has no AP credit behind it — paying it drove AP
  // to a debit balance. Deleted is checked before, and apart from, status.
  if (bill.deleted) {
    throw new SupplierPaymentRefusal(
      `Invoice ${bill.invoiceNumber} has been deleted and cannot receive a payment.`,
    );
  }
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

/**
 * Integer cents. A BILL's outstanding is compared in cents with no tolerance:
 * the old `amount > outstanding + EPS` let a fully paid bill take R0.01 and a
 * R100.00 bill take R100.01.
 */
export function toCents(n: number): number {
  return Math.round(n * 100);
}

/**
 * FX PR0: the locked bill rows a payment is about to settle, refused (400,
 * before any write) if one is in a foreign currency, whatever the switch —
 * settlement is currency-blind and would add rands to its
 * foreign amount_paid. Every AP path locks its bills through
 * `fetchBillCandidates`, which passes its rows through here: creating a
 * payment or a batch, processing either, and applying a payment.
 */
export async function billsPayable<T extends { invoice_number: unknown; currency?: unknown; currency_code?: unknown }>(
  companyId: string, rows: T[],
): Promise<T[]> {
  if (rows.length === 0) return rows;
  const company = await loadCompanyCurrency(companyId);
  for (const row of rows) {
    try {
      assertSettleableCurrency(company, [row.currency_code, row.currency], 'bill');
    } catch (err) {
      if (!(err instanceof DocumentCurrencyError)) throw err;
      throw new SupplierPaymentRefusal(`Invoice ${String(row.invoice_number)} cannot be paid: ${err.message}`);
    }
  }
  return rows;
}
