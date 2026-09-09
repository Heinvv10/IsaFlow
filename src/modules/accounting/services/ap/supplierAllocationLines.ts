/**
 * The bill half of applying a supplier payment: shape validation, one
 * company-scoped read of every candidate bill, and the per-line before/after.
 *
 * The AP mirror of `ar/receiptAllocationLines.ts`, kept as its own file rather
 * than generalised: the two read different tables, resolve their counterparty
 * differently (`supplier_invoices.supplier_id` is a single column;
 * `customer_invoices` carries both `client_id` and `customer_id`), and the AP
 * side additionally maintains `payment_matched`. A shared generic over both
 * would carry a discriminator into every line of it and be harder to read than
 * two honest halves.
 *
 * `payment_allocations` is the live allocation table. Migration 201's
 * `supplier_payment_allocations` holds zero rows in dev and in production and
 * is read by nothing — `processSupplierPayment`, `voidSupplierPayment` and
 * `batchPaymentService` all use `payment_allocations`. The inline SQL at
 * `pages/api/accounting/supplier-allocations.ts` writes the other one, which is
 * why its allocations never affected anything downstream.
 */

import { BALANCE_DERIVED, recomputeInvoiceStatus } from '../ar/invoiceStatusRecompute';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/** A cent. Money comparisons are made at this tolerance, never exactly. */
export const EPS = 0.01;

/**
 * Statuses a bill may be in to take a payment — an ALLOW-list, deliberately.
 *
 * The deny-list this replaces named 'cancelled' and 'draft' only, so the other
 * two statuses `supplier_invoices_status_check` permits — 'pending_approval'
 * and 'disputed' — passed the gate. AP is credited only by
 * `approveSupplierInvoice`, so such a bill has no journal at all: the payment's
 * DR Accounts Payable had no matching credit, and `recomputeInvoiceStatus`
 * left the status alone (it too restricts itself to BALANCE_DERIVED), so the
 * bill read unapproved and fully paid at the same time.
 *
 * It is the SAME set `recomputeInvoiceStatus` will act on afterwards, which is
 * the point: a status that recompute refuses to move must not be allowed to
 * take money either. A status added to the CHECK constraint later fails closed
 * here rather than silently joining the allowed set.
 */
const ALLOCATABLE_STATUSES = new Set(BALANCE_DERIVED);

export interface SupplierAllocationInput {
  invoiceId: string;
  amount: number;
}

export interface SupplierApplicationLine {
  invoiceId: string;
  invoiceNumber: string;
  amount: number;
  outstandingBefore: number;
  outstandingAfter: number;
  statusBefore: string;
  statusAfter: string;
  /** True when this line settles the bill in full and sets `payment_matched`. */
  fullySettled: boolean;
}

interface BillCandidate extends DbRow {
  id: string;
  invoice_number: string;
  supplier_id: string;
  total_amount: string | number;
  amount_paid: string | number | null;
  status: string;
  already_allocated: string | number | null;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Faults in the REQUEST — checked before any query, naming the offending bill. */
export function assertAllocationShape(allocations: readonly SupplierAllocationInput[]): void {
  if (allocations.length === 0) throw new Error('Provide at least one allocation.');
  const seen = new Set<string>();
  for (const alloc of allocations) {
    if (!Number.isFinite(alloc.amount) || alloc.amount <= 0) {
      throw new Error(`Allocation amount for invoice ${alloc.invoiceId} must be a positive number.`);
    }
    if (seen.has(alloc.invoiceId)) {
      // The unique index on (payment_id, invoice_id) would raise 23505 halfway
      // through the write instead — a database error the caller cannot act on,
      // arriving after earlier lines have been written.
      throw new Error(`Invoice ${alloc.invoiceId} appears more than once in this request.`);
    }
    seen.add(alloc.invoiceId);
  }
}

/**
 * Validate every allocation against the live bill rows and return the lines
 * plus the supplier they all belong to. Reads only.
 *
 * @param supplierId When given, every bill must belong to it. When null the
 *   supplier is taken from the first bill and the rest must match — the
 *   bank-allocation path, where the payment has no counterparty until its bills
 *   name one.
 */
export async function planSupplierAllocationLines(
  companyId: string,
  allocations: readonly SupplierAllocationInput[],
  opts: { paymentId: string | null; supplierId: string | null },
): Promise<{ supplierId: string; lines: SupplierApplicationLine[] }> {
  assertAllocationShape(allocations);

  const byId = await fetchBillCandidates(
    companyId,
    opts.paymentId,
    allocations.map((a) => a.invoiceId),
  );

  let supplierId = opts.supplierId;
  const lines: SupplierApplicationLine[] = [];
  for (const alloc of allocations) {
    const bill = byId.get(alloc.invoiceId);
    // Same wording as a genuine miss: a bill in another tenant must not be
    // distinguishable from one that does not exist.
    if (!bill) throw new Error(`Invoice ${alloc.invoiceId} not found`);
    supplierId ??= String(bill.supplier_id);
    lines.push(buildLine(alloc, bill, supplierId));
  }

  if (!supplierId) throw new Error('Provide at least one allocation.');
  return { supplierId, lines };
}

async function fetchBillCandidates(
  companyId: string,
  paymentId: string | null,
  invoiceIds: readonly string[],
): Promise<Map<string, BillCandidate>> {
  const rows = (await sql`
    SELECT si.id,
           si.invoice_number,
           si.supplier_id,
           si.total_amount,
           si.amount_paid,
           si.status,
           COALESCE((
             SELECT SUM(pa.amount_allocated)
             FROM payment_allocations pa
             WHERE pa.invoice_id = si.id
               AND pa.payment_id = ${paymentId}::UUID
           ), 0) AS already_allocated
    FROM supplier_invoices si
    WHERE si.company_id = ${companyId}::UUID
      AND si.id = ANY(${[...invoiceIds]}::UUID[])
  `) as BillCandidate[];
  return new Map(rows.map((r) => [String(r.id), r]));
}

/**
 * The two facts about a bill that decide whether ANY payment may touch it: its
 * status, and whose bill it is. Exported because `createSupplierPayment` runs
 * its own bill query (it additionally counts unprocessed payments' pending
 * allocations, which this file does not) and must refuse on the same terms.
 */
export function assertBillAllocatable(
  bill: { invoiceNumber: string; status: string; supplierId: string },
  expectedSupplierId: string,
): void {
  if (!ALLOCATABLE_STATUSES.has(bill.status)) {
    throw new Error(
      `Invoice ${bill.invoiceNumber} is ${bill.status} and cannot receive a payment.`,
    );
  }
  if (bill.supplierId !== expectedSupplierId) {
    throw new Error(
      `Invoice ${bill.invoiceNumber} belongs to a different supplier than this payment.`,
    );
  }
}

function buildLine(
  alloc: SupplierAllocationInput,
  bill: BillCandidate,
  supplierId: string,
): SupplierApplicationLine {
  const statusBefore = String(bill.status);
  assertBillAllocatable({
    invoiceNumber: String(bill.invoice_number),
    status: statusBefore,
    supplierId: String(bill.supplier_id),
  }, supplierId);
  if (Number(bill.already_allocated ?? 0) > 0) {
    throw new Error(
      `This payment is already allocated against invoice ${String(bill.invoice_number)}. `
      + 'A payment applies to a bill once; use a second payment to apply more.',
    );
  }
  const total = Number(bill.total_amount);
  const outstandingBefore = round2(total - Number(bill.amount_paid ?? 0));
  if (alloc.amount > outstandingBefore + EPS) {
    throw new Error(
      `R${alloc.amount.toFixed(2)} exceeds the R${outstandingBefore.toFixed(2)} outstanding on `
      + `invoice ${String(bill.invoice_number)}.`,
    );
  }
  const outstandingAfter = round2(outstandingBefore - alloc.amount);
  const fullySettled = outstandingAfter <= EPS;

  return {
    invoiceId: alloc.invoiceId,
    invoiceNumber: String(bill.invoice_number),
    amount: alloc.amount,
    outstandingBefore,
    outstandingAfter,
    statusBefore,
    statusAfter: fullySettled ? 'paid' : 'partially_paid',
    fullySettled,
  };
}

/**
 * Move one bill's `amount_paid` by a RELATIVE amount, recompute its status, and
 * maintain `payment_matched`.
 *
 * `payment_matched` is DERIVED from the settlement, not preserved — an
 * assignment, never a CASE that can only ever set it TRUE. That distinction is
 * load-bearing rather than stylistic.
 *
 * `allocateTransaction` calls `fourWayMatchService#recordPaymentMatch` with the
 * FULL bank-line amount against the FIRST invoice named, and that function sets
 * the flag whenever `amount_paid + <whole line> >= total_amount`. So a R1,000
 * line allocating R300 to a R600 bill flags that bill as payment-matched before
 * this ever runs, and the bill is half paid. A CASE that preserved the existing
 * value would keep the lie; deriving the flag from what was actually settled
 * overwrites it. `payment_matched_at` follows the same rule and is cleared when
 * the flag goes false, so a stale timestamp cannot outlive the claim it dates.
 *
 * The wider point stands: the bank-allocation path used to set the FLAG and
 * nothing else — it never moved `amount_paid` or `status` — which is how
 * seventeen bills read as wholly outstanding while the GL showed them paid.
 * Both halves move together or the split comes back.
 *
 * `balance` is a stored generated column (`total_amount - amount_paid`) and is
 * deliberately not written: Postgres maintains it.
 */
export async function applyLineToBill(
  companyId: string,
  line: SupplierApplicationLine,
): Promise<void> {
  // MONEY ONLY, mirroring the AR twin. `status`, `payment_matched` and
  // `payment_matched_at` all derive from ONE threshold — `amount_paid >=
  // total_amount - EPS` — and `recomputeInvoiceStatus` owns that threshold.
  // Three columns on one condition, written in one place.
  //
  // BEHAVIOUR CHANGE, deliberate: the helper restricts itself to
  // `status = ANY(BALANCE_DERIVED)`, which this statement never did. A bill
  // that is `cancelled`, `draft` or `written_off` is now left alone entirely,
  // flag included — a payment figure is not evidence about any of them. The
  // inline version would happily have flagged a cancelled bill matched.
  await sql`
    UPDATE supplier_invoices
    SET amount_paid = COALESCE(amount_paid, 0) + ${line.amount},
        updated_at = NOW()
    WHERE id = ${line.invoiceId}::UUID AND company_id = ${companyId}::UUID
  `;
  await recomputeInvoiceStatus(companyId, 'supplier', line.invoiceId);
}
