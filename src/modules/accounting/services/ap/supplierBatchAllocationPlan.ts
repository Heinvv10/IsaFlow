/**
 * The allocation gate for the two AP paths that do not go through
 * `planSupplierAllocationLines`: CREATING a batch, and PROCESSING a payment or
 * a batch — the moment money actually moves.
 *
 * Creation: `createBatch` used to loop the request body straight into
 * `payment_allocations`. No statement read `supplier_invoices`, and that
 * table's FK to `supplier_invoices(id)` carries no company predicate — so
 * another tenant's bill, another supplier's bill, an unapproved bill and an
 * over-payment were all accepted (K-064).
 *
 * Processing: a create-time check alone is not enough. A payment created
 * against an approved bill whose bill is then cancelled, disputed, sent back
 * to pending_approval or reassigned to another supplier still debited AP and
 * settled that bill when processed — K-063/K-066 reached by a different
 * ordering. So `processSupplierPayment` and `processBatch` re-run the SAME rule
 * (`buildLine` → `assertBillAllocatable`) on the bills read under lock, before
 * their claim and before any journal.
 *
 * ONE locked read over every bill, not one per payment: `fetchBillCandidates`
 * sorts by id, so every caller on the settlement path takes bills in the same
 * sequence, and a contended bill is a retryable `SupplierPaymentRefusal`
 * (409), never a 400.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import {
  buildLine,
  fetchBillCandidates,
  round2,
  type SupplierAllocationInput,
} from './supplierAllocationLines';
import { assertAllocationShape } from './supplierAllocationShape';
import { SupplierPaymentRefusal } from './supplierPaymentRefusal';

export interface BatchPaymentLines {
  supplierId: string;
  allocations: readonly SupplierAllocationInput[];
}

/** One allocation as stored: whose payment it is, which bill, how much. */
export interface StoredAllocation extends SupplierAllocationInput {
  supplierId: string;
}

/** Creation: shape batch-wide, then every line against the bills and what is already promised. */
export async function assertBatchAllocatable(
  companyId: string,
  payments: readonly BatchPaymentLines[],
): Promise<void> {
  if (payments.length === 0) throw new SupplierPaymentRefusal('Provide at least one payment.');
  for (const p of payments) {
    if (p.allocations.length === 0) throw new SupplierPaymentRefusal('Provide at least one allocation.');
  }
  // Across the WHOLE batch: a bill named by two payments would otherwise pass
  // the balance check twice against the same outstanding.
  assertAllocationShape(payments.flatMap((p) => p.allocations));
  await checkUnderLock(companyId, payments.flatMap((p) =>
    p.allocations.map((a) => ({ ...a, supplierId: p.supplierId }))), { countPending: true });
}

/**
 * Processing: every stored allocation must STILL be allocatable. Unprocessed
 * payments are not counted — this payment is one of them, and `amount_paid`
 * is what the bill has actually taken.
 */
export async function assertAllocationsStillAllocatable(
  companyId: string,
  allocations: readonly StoredAllocation[],
): Promise<void> {
  if (allocations.length === 0) return;
  await checkUnderLock(companyId, allocations, { countPending: false });
}

/**
 * What unprocessed (draft / approved) payments have already promised against
 * each bill — THE pending set. Batch creation subtracts it under the bill lock;
 * the new-batch page subtracts the same figure so it never offers an amount
 * this check would refuse. One query, both callers.
 */
export async function pendingReservations(companyId: string, invoiceIds: readonly string[]): Promise<Map<string, number>> {
  const rows = (await sql`
    SELECT pa.invoice_id, COALESCE(SUM(pa.amount_allocated), 0) AS pending
    FROM payment_allocations pa
    JOIN supplier_payments sp ON sp.id = pa.payment_id
    WHERE pa.invoice_id = ANY(${[...invoiceIds]}::UUID[])
      AND sp.company_id = ${companyId}::UUID
      AND sp.status IN ('draft', 'approved')
    GROUP BY pa.invoice_id
  `) as DbRow[];
  return new Map(rows.map((r) => [String(r.invoice_id), Number(r.pending)]));
}

async function checkUnderLock(
  companyId: string,
  lines: readonly StoredAllocation[],
  opts: { countPending: boolean },
): Promise<void> {
  const ids = [...new Set(lines.map((l) => l.invoiceId))];
  const byId = await fetchBillCandidates(companyId, null, ids);

  // Read AFTER the lock. `amount_paid` moves only at process time, so an
  // unprocessed payment's allocation is money already promised; without it two
  // batches (or a batch and a draft payment) each take the full outstanding.
  // A concurrent batch on the same bill waited on the lock above, and under
  // READ COMMITTED this later statement sees the allocations it committed.
  const taken = opts.countPending ? await pendingReservations(companyId, ids) : new Map<string, number>();

  for (const line of lines) {
    const bill = byId.get(line.invoiceId);
    // Same wording as a genuine miss: another tenant's bill must not be
    // distinguishable from one that does not exist.
    if (!bill) throw new SupplierPaymentRefusal(`Invoice ${line.invoiceId} not found`);
    const before = taken.get(line.invoiceId) ?? 0;
    buildLine(line, {
      ...bill,
      amount_paid: round2(Number(bill.amount_paid ?? 0) + before),
    }, line.supplierId);
    // A stored batch predating the create-time duplicate check may name one
    // bill twice; each line is measured against what the earlier ones took.
    taken.set(line.invoiceId, round2(before + line.amount));
  }
}

/**
 * Processing a BATCH: every member must still be unprocessed and every bill
 * still allocatable. `processBatch` posts ONE journal for the batch total and
 * applies every member's allocations, so a member already processed on its own
 * (the single path now refuses batch members, but stored data may predate
 * that) would be paid a second time. The caller holds the batch row lock.
 */
export async function assertBatchMembersStillAllocatable(companyId: string, batchId: string): Promise<void> {
  const stored = (await sql`
    SELECT sp.payment_number, sp.status, sp.supplier_id, pa.invoice_id, pa.amount_allocated
    FROM supplier_payments sp
    JOIN payment_allocations pa ON pa.payment_id = sp.id
    WHERE sp.batch_id = ${batchId}::UUID AND sp.company_id = ${companyId}::UUID
    ORDER BY pa.invoice_id
  `) as DbRow[];
  const moved = stored.find((r) => String(r.status) !== 'approved');
  if (moved) {
    throw new SupplierPaymentRefusal(`Payment ${String(moved.payment_number)} in this batch is `
      + `${String(moved.status)}, not approved — the batch cannot be processed.`);
  }
  await assertAllocationsStillAllocatable(companyId, stored.map((r) => ({
    invoiceId: String(r.invoice_id), amount: Number(r.amount_allocated), supplierId: String(r.supplier_id),
  })));
}
