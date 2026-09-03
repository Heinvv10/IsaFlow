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

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/** A cent. Money comparisons are made at this tolerance, never exactly. */
export const EPS = 0.01;

/** Statuses whose bill is void or not yet a payable and cannot take a payment. */
const UNALLOCATABLE_STATUSES = new Set(['cancelled', 'draft']);

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

function buildLine(
  alloc: SupplierAllocationInput,
  bill: BillCandidate,
  supplierId: string,
): SupplierApplicationLine {
  const statusBefore = String(bill.status);
  if (UNALLOCATABLE_STATUSES.has(statusBefore)) {
    throw new Error(
      `Invoice ${String(bill.invoice_number)} is ${statusBefore} and cannot receive a payment.`,
    );
  }
  if (Number(bill.already_allocated ?? 0) > 0) {
    throw new Error(
      `This payment is already allocated against invoice ${String(bill.invoice_number)}. `
      + 'A payment applies to a bill once; use a second payment to apply more.',
    );
  }
  if (String(bill.supplier_id) !== supplierId) {
    throw new Error(
      `Invoice ${String(bill.invoice_number)} belongs to a different supplier than this payment.`,
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
 * `payment_matched` is set here as well as by `recordPaymentMatch`, and that is
 * the point: the bank-allocation path used to set the FLAG and nothing else —
 * it never moved `amount_paid` or `status` — which is how seventeen bills could
 * read as wholly outstanding while the GL showed them paid. Both halves move
 * together or the split comes back.
 *
 * `balance` is a stored generated column (`total_amount - amount_paid`) and is
 * deliberately not written: Postgres maintains it.
 */
export async function applyLineToBill(
  companyId: string,
  line: SupplierApplicationLine,
): Promise<void> {
  await sql`
    UPDATE supplier_invoices
    SET amount_paid = COALESCE(amount_paid, 0) + ${line.amount},
        status = CASE
          WHEN (total_amount - (COALESCE(amount_paid, 0) + ${line.amount})) <= ${EPS} THEN 'paid'
          WHEN (COALESCE(amount_paid, 0) + ${line.amount}) > 0 THEN 'partially_paid'
          ELSE status
        END,
        payment_matched = CASE
          WHEN (total_amount - (COALESCE(amount_paid, 0) + ${line.amount})) <= ${EPS} THEN TRUE
          ELSE payment_matched
        END,
        payment_matched_at = CASE
          WHEN (total_amount - (COALESCE(amount_paid, 0) + ${line.amount})) <= ${EPS}
            THEN COALESCE(payment_matched_at, NOW())
          ELSE payment_matched_at
        END,
        updated_at = NOW()
    WHERE id = ${line.invoiceId}::UUID AND company_id = ${companyId}::UUID
  `;
}
