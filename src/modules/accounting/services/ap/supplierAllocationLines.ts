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

import { recomputeInvoiceStatus } from '../ar/invoiceStatusRecompute';
import { SupplierPaymentRefusal } from './supplierPaymentRefusal';
import { sql } from '@/lib/neon';
import { requireRequestTransaction } from '../core/requestTransaction';
import { isLockContention } from '../core/lockContention';
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
  if (allocations.length === 0) throw new SupplierPaymentRefusal('Provide at least one allocation.');
  const seen = new Set<string>();
  for (const alloc of allocations) {
    if (!Number.isFinite(alloc.amount) || alloc.amount <= 0) {
      throw new SupplierPaymentRefusal(`Allocation amount for invoice ${alloc.invoiceId} must be a positive number.`);
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
    if (!bill) throw new SupplierPaymentRefusal(`Invoice ${alloc.invoiceId} not found`);
    supplierId ??= String(bill.supplier_id);
    lines.push(buildLine(alloc, bill, supplierId));
  }

  if (!supplierId) throw new SupplierPaymentRefusal('Provide at least one allocation.');
  return { supplierId, lines };
}

/**
 * Read the bills this allocation names, holding a row lock on each until the
 * end of the surrounding transaction.
 *
 * THE LOCK IS LOAD-BEARING, and for the same reason as its AR mirror
 * `fetchInvoiceCandidates`. Paying a bill is a check-then-act on
 * `supplier_invoices.amount_paid`: `outstandingBefore` is read here, the
 * over-payment guard is decided from it in `buildLine`, and the column is moved
 * much later in `applyLineToBill`. Nothing else on the AP path locks the bill —
 * `lockSupplierPaymentForUpdate` protects a PAYMENT the same transaction
 * created, and `bankTxLock` protects a bank LINE, a different row per request.
 * So two bank lines confirmed against one bill both read the same outstanding,
 * both pass, and both apply; the only thing that ever stopped them was a
 * collision on `uq_gl_je_company_entry_number` inside `createJournalEntry` —
 * the money path's safety resting on an index that exists to number journals.
 *
 * `ORDER BY si.id` fixes the lock ORDER (`LockRows` sits above `Sort`), so two
 * requests naming the same pair of bills take them in the same sequence and
 * cannot deadlock against each other.
 *
 * A timeout is a REFUSAL: it is raised before anything on this path has been
 * written, and retrying unchanged is the right move. A DEADLOCK (40P01) is
 * answered the same way, via `isLockContention` — see the canonical lock order
 * in `bank/.claude.md` for why one should not arise here at all.
 */
async function fetchBillCandidates(
  companyId: string,
  paymentId: string | null,
  invoiceIds: readonly string[],
): Promise<Map<string, BillCandidate>> {
  const client = requireRequestTransaction('fetchBillCandidates');
  await client.query("SET LOCAL lock_timeout = '5s'");
  try {
    return await lockBillCandidates(companyId, paymentId, invoiceIds, client);
  } catch (err) {
    if (isLockContention(err)) {
      throw new SupplierPaymentRefusal(
        'Another request is paying one of these bills — retry in a moment.',
      );
    }
    throw err;
  }
}

async function lockBillCandidates(
  companyId: string,
  paymentId: string | null,
  invoiceIds: readonly string[],
  client: { query: (t: string) => Promise<unknown> },
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
    ORDER BY si.id
    FOR UPDATE OF si
  `) as BillCandidate[];
  // Restore the default on the SUCCESS path only. `SET LOCAL` lasts to the end
  // of the TRANSACTION, so without this the 5s budget silently governs every
  // lock taken afterwards in the same request. Deliberately NOT in a `finally`:
  // after a timeout the transaction is aborted and this statement would itself
  // throw 25P02, replacing the typed refusal with an opaque error.
  await client.query('SET LOCAL lock_timeout = DEFAULT');
  return new Map(rows.map((r) => [String(r.id), r]));
}

function buildLine(
  alloc: SupplierAllocationInput,
  bill: BillCandidate,
  supplierId: string,
): SupplierApplicationLine {
  const statusBefore = String(bill.status);
  if (UNALLOCATABLE_STATUSES.has(statusBefore)) {
    throw new SupplierPaymentRefusal(
      `Invoice ${String(bill.invoice_number)} is ${statusBefore} and cannot receive a payment.`,
    );
  }
  if (Number(bill.already_allocated ?? 0) > 0) {
    throw new SupplierPaymentRefusal(
      `This payment is already allocated against invoice ${String(bill.invoice_number)}. `
      + 'A payment applies to a bill once; use a second payment to apply more.',
    );
  }
  if (String(bill.supplier_id) !== supplierId) {
    throw new SupplierPaymentRefusal(
      `Invoice ${String(bill.invoice_number)} belongs to a different supplier than this payment.`,
    );
  }

  const total = Number(bill.total_amount);
  const outstandingBefore = round2(total - Number(bill.amount_paid ?? 0));
  // The LAST line of defence on this threshold, not the only one. A caller that
  // must decide the refusal before its first write refuses earlier on the same
  // arithmetic and the same EPS — `confirmSupplierMatch.ts` does, because a 4xx
  // raised after a write COMMITs it — so this one is unreachable from that path.
  // Both must move together if the tolerance ever changes.
  if (alloc.amount > outstandingBefore + EPS) {
    throw new SupplierPaymentRefusal(
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
