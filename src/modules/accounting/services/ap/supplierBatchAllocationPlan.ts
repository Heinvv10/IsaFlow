/**
 * The bill half of CREATING a supplier payment batch: every line of every
 * payment checked against the live bills before the batch writes anything.
 *
 * `createBatch` used to loop the request body straight into
 * `payment_allocations`. No statement read `supplier_invoices`, and that
 * table's FK to `supplier_invoices(id)` carries no company predicate — so
 * another tenant's bill, another supplier's bill, an unapproved bill and an
 * over-payment were all accepted, and `processBatch` then debited Accounts
 * Payable for the batch's full total while its company-scoped subledger UPDATE
 * skipped the foreign bill.
 *
 * ONE locked read over the whole batch, not one per payment: two batches
 * naming the same bills under different payments would otherwise take their
 * locks in different orders. `fetchBillCandidates` sorts by id, so every
 * caller on the settlement path takes bills in the same sequence, and a
 * contended bill is a retryable `SupplierPaymentRefusal` (409), never a 400.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import {
  assertAllocationShape,
  buildLine,
  fetchBillCandidates,
  round2,
  type SupplierAllocationInput,
} from './supplierAllocationLines';
import { SupplierPaymentRefusal } from './supplierPaymentRefusal';

export interface BatchPaymentLines {
  supplierId: string;
  allocations: readonly SupplierAllocationInput[];
}

export async function assertBatchAllocatable(
  companyId: string,
  payments: readonly BatchPaymentLines[],
): Promise<void> {
  if (payments.length === 0) throw new SupplierPaymentRefusal('Provide at least one payment.');
  // Across the WHOLE batch: a bill named by two payments would otherwise pass
  // the balance check twice against the same outstanding.
  const all = payments.flatMap((p) => p.allocations);
  for (const p of payments) {
    if (p.allocations.length === 0) throw new SupplierPaymentRefusal('Provide at least one allocation.');
  }
  assertAllocationShape(all);

  const ids = all.map((a) => a.invoiceId);
  const byId = await fetchBillCandidates(companyId, null, ids);

  // Read AFTER the lock. `amount_paid` moves only at process time, so an
  // unprocessed payment's allocation is money already promised; without it two
  // batches (or a batch and a draft payment) each take the full outstanding.
  // A concurrent batch on the same bill waited on the lock above, and under
  // READ COMMITTED this later statement sees the allocations it committed.
  const pendingRows = (await sql`
    SELECT pa.invoice_id, COALESCE(SUM(pa.amount_allocated), 0) AS pending
    FROM payment_allocations pa
    JOIN supplier_payments sp ON sp.id = pa.payment_id
    WHERE pa.invoice_id = ANY(${ids}::UUID[])
      AND sp.company_id = ${companyId}::UUID
      AND sp.status IN ('draft', 'approved')
    GROUP BY pa.invoice_id
  `) as DbRow[];
  const pending = new Map(pendingRows.map((r) => [String(r.invoice_id), Number(r.pending)]));

  for (const p of payments) {
    for (const alloc of p.allocations) {
      const bill = byId.get(alloc.invoiceId);
      // Same wording as a genuine miss: another tenant's bill must not be
      // distinguishable from one that does not exist.
      if (!bill) throw new SupplierPaymentRefusal(`Invoice ${alloc.invoiceId} not found`);
      const promised = pending.get(alloc.invoiceId) ?? 0;
      buildLine(alloc, {
        ...bill,
        amount_paid: round2(Number(bill.amount_paid ?? 0) + promised),
      }, p.supplierId);
    }
  }
}
