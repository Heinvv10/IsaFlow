/**
 * The invoice half of applying a customer receipt: shape validation, one
 * company-scoped read of every candidate invoice, and the per-line
 * before/after that both callers report.
 *
 * Shared by `receiptApplicationService` (applying cash already in the ledger)
 * and `receiptMatchConfirmService` (allocating a bank line and applying it in
 * one go). They are the same guards over the same rows; splitting them would be
 * two answers to "may this receipt settle this invoice", and the two would
 * drift.
 *
 * `COALESCE(ci.client_id, ci.customer_id)` is the counterparty. Both columns
 * exist on `customer_invoices` and either may be the populated one — the inline
 * SQL this replaces compared `client_id` alone, which is false for every
 * invoice populated on `customer_id` and refused them outright.
 */

import { recomputeInvoiceStatus } from './invoiceStatusRecompute';
import { ReceiptRefusal } from './receiptRefusal';
import { sql } from '@/lib/neon';
import { requireRequestTransaction } from '../core/requestTransaction';
import type { DbRow } from '@/lib/neon';

/** A cent. Money comparisons are made at this tolerance, never exactly. */
export const EPS = 0.01;

/** Statuses whose invoice is void or not yet a receivable and cannot take cash. */
const UNALLOCATABLE_INVOICE_STATUSES = new Set(['cancelled', 'draft']);

export interface ReceiptAllocationInput {
  invoiceId: string;
  amount: number;
}

export interface ReceiptApplicationLine {
  invoiceId: string;
  invoiceNumber: string;
  amount: number;
  outstandingBefore: number;
  outstandingAfter: number;
  statusBefore: string;
  statusAfter: string;
}

interface InvoiceCandidate extends DbRow {
  id: string;
  invoice_number: string;
  owner_id: string | null;
  total_amount: string | number;
  amount_paid: string | number | null;
  status: string;
  already_allocated: string | number | null;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Faults in the REQUEST — checked before any query runs, so they cost nothing
 * and name the offending invoice.
 */
export function assertAllocationShape(allocations: readonly ReceiptAllocationInput[]): void {
  if (allocations.length === 0) {
    throw new ReceiptRefusal('Provide at least one allocation.');
  }
  const seen = new Set<string>();
  for (const alloc of allocations) {
    if (!Number.isFinite(alloc.amount) || alloc.amount <= 0) {
      throw new ReceiptRefusal(`Allocation amount for invoice ${alloc.invoiceId} must be a positive number.`);
    }
    if (seen.has(alloc.invoiceId)) {
      // The unique index on (payment_id, invoice_id) would otherwise raise
      // 23505 halfway through the write: a database error the caller cannot
      // act on, arriving after earlier lines have already been written.
      throw new ReceiptRefusal(`Invoice ${alloc.invoiceId} appears more than once in this request.`);
    }
    seen.add(alloc.invoiceId);
  }
}

/**
 * Validate every allocation against the live invoice rows and return the lines
 * plus the customer they all belong to. Reads only.
 *
 * @param paymentId When given, each invoice also reports what THIS payment has
 *   already been allocated against it, so a second application of one receipt
 *   to one invoice refuses with a message rather than a 23505.
 * @param customerId When given, every invoice must belong to it. When null the
 *   customer is taken from the first invoice and the rest must match it — the
 *   bank-allocation path, where the receipt has no counterparty until its
 *   invoices name one.
 */
export async function planAllocationLines(
  companyId: string,
  allocations: readonly ReceiptAllocationInput[],
  opts: { paymentId: string | null; customerId: string | null },
): Promise<{ customerId: string; lines: ReceiptApplicationLine[] }> {
  assertAllocationShape(allocations);

  const byId = await fetchInvoiceCandidates(
    companyId,
    opts.paymentId,
    allocations.map((a) => a.invoiceId),
  );

  let customerId = opts.customerId;
  const lines: ReceiptApplicationLine[] = [];
  for (const alloc of allocations) {
    const invoice = byId.get(alloc.invoiceId);
    // Same wording as a genuine miss: an invoice in another tenant must not be
    // distinguishable from one that does not exist.
    if (!invoice) throw new ReceiptRefusal(`Invoice ${alloc.invoiceId} not found`);
    const ownerId = invoice.owner_id ? String(invoice.owner_id) : null;
    if (!ownerId) {
      throw new ReceiptRefusal(
        `Invoice ${String(invoice.invoice_number)} names no customer — it carries neither `
        + 'client_id nor customer_id, so a receipt cannot be attributed to it.',
      );
    }
    customerId ??= ownerId;
    lines.push(buildLine(alloc, invoice, customerId));
  }

  // Unreachable while `allocations` is non-empty (assertAllocationShape), but
  // the compiler cannot see that and a silent `''` would be worse.
  if (!customerId) throw new ReceiptRefusal('Provide at least one allocation.');
  return { customerId, lines };
}

/** Postgres `lock_not_available` — `lock_timeout` elapsed waiting for the row. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Read the invoices this allocation names, holding a row lock on each until the
 * end of the surrounding transaction.
 *
 * THE LOCK IS LOAD-BEARING. Applying cash is a check-then-act on
 * `customer_invoices.amount_paid`: the outstanding balance is read here, the
 * over-application guard is decided from it in `buildLine`, and the column is
 * moved much later in `applyLineToInvoice`. Nothing else on the path locks the
 * invoice — `lockCustomerPaymentForUpdate` protects the RECEIPT's remainder,
 * and `bankTxLock` protects a bank LINE, which is a different row for each of
 * two requests. So two bank lines confirmed against one invoice both read the
 * same outstanding, both pass, and both apply.
 *
 * Measured before this lock existed (two pool clients, eight interleavings):
 * they never over-applied, but only because the second request collided on
 * `uq_gl_je_company_entry_number` inside `createJournalEntry` and was rolled
 * back — the money path's safety resting on a unique index that exists to
 * number journals. The user saw a bare 500 where the same request 20ms later
 * got the actionable 400.
 *
 * `ORDER BY ci.id` fixes the lock ORDER: `LockRows` sits above `Sort`, so two
 * requests naming the same pair of invoices take them in the same sequence and
 * cannot deadlock against each other.
 *
 * The wait is bounded rather than indefinite, and a timeout is a REFUSAL: it is
 * raised before anything on this path has been written, and retrying unchanged
 * is the right move. (55P03 aborts the transaction, so the 400 the caller
 * answers with is COMMITted over an already-rolled-back transaction — which
 * writes nothing, the same as every other pre-write refusal here.)
 */
async function fetchInvoiceCandidates(
  companyId: string,
  paymentId: string | null,
  invoiceIds: readonly string[],
): Promise<Map<string, InvoiceCandidate>> {
  // Refused, not skipped: without a request transaction the lock below is
  // released at the end of its own statement and protects nothing, silently.
  const client = requireRequestTransaction('fetchInvoiceCandidates');
  await client.query("SET LOCAL lock_timeout = '5s'");
  try {
    return await lockInvoiceCandidates(companyId, paymentId, invoiceIds, client);
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === LOCK_NOT_AVAILABLE) {
      throw new ReceiptRefusal(
        'Another request is applying cash to one of these invoices — retry in a moment.',
      );
    }
    throw err;
  }
}

async function lockInvoiceCandidates(
  companyId: string,
  paymentId: string | null,
  invoiceIds: readonly string[],
  client: { query: (t: string) => Promise<unknown> },
): Promise<Map<string, InvoiceCandidate>> {
  const rows = (await sql`
    SELECT ci.id,
           ci.invoice_number,
           COALESCE(ci.client_id, ci.customer_id) AS owner_id,
           ci.total_amount,
           ci.amount_paid,
           ci.status,
           COALESCE((
             SELECT SUM(cpa.amount_allocated)
             FROM customer_payment_allocations cpa
             WHERE cpa.invoice_id = ci.id
               AND cpa.payment_id = ${paymentId}::UUID
           ), 0) AS already_allocated
    FROM customer_invoices ci
    WHERE ci.company_id = ${companyId}::UUID
      AND ci.id = ANY(${[...invoiceIds]}::UUID[])
    ORDER BY ci.id
    FOR UPDATE OF ci
  `) as InvoiceCandidate[];
  // Restore the default on the SUCCESS path only. `SET LOCAL` lasts to the end
  // of the TRANSACTION, so without this the 5s budget silently governs every
  // lock taken afterwards in the same request. Deliberately NOT in a `finally`:
  // after a timeout the transaction is aborted and this statement would itself
  // throw 25P02, replacing the typed refusal with an opaque error.
  await client.query('SET LOCAL lock_timeout = DEFAULT');
  return new Map(rows.map((r) => [String(r.id), r]));
}

function buildLine(
  alloc: ReceiptAllocationInput,
  invoice: InvoiceCandidate,
  customerId: string,
): ReceiptApplicationLine {
  const statusBefore = String(invoice.status);
  if (UNALLOCATABLE_INVOICE_STATUSES.has(statusBefore)) {
    throw new ReceiptRefusal(
      `Invoice ${String(invoice.invoice_number)} is ${statusBefore} and cannot receive a receipt.`,
    );
  }
  if (Number(invoice.already_allocated ?? 0) > 0) {
    throw new ReceiptRefusal(
      `This receipt is already allocated against invoice ${String(invoice.invoice_number)}. `
      + 'A receipt applies to an invoice once; use a second receipt to apply more.',
    );
  }
  const ownerId = invoice.owner_id ? String(invoice.owner_id) : null;
  if (ownerId !== customerId) {
    throw new ReceiptRefusal(
      `Invoice ${String(invoice.invoice_number)} belongs to a different customer than this receipt.`,
    );
  }

  const total = Number(invoice.total_amount);
  const outstandingBefore = round2(total - Number(invoice.amount_paid ?? 0));
  if (alloc.amount > outstandingBefore + EPS) {
    throw new ReceiptRefusal(
      `R${alloc.amount.toFixed(2)} exceeds the R${outstandingBefore.toFixed(2)} outstanding on `
      + `invoice ${String(invoice.invoice_number)}.`,
    );
  }
  const outstandingAfter = round2(outstandingBefore - alloc.amount);

  return {
    invoiceId: alloc.invoiceId,
    invoiceNumber: String(invoice.invoice_number),
    amount: alloc.amount,
    outstandingBefore,
    outstandingAfter,
    statusBefore,
    statusAfter: outstandingAfter <= EPS ? 'paid' : 'partially_paid',
  };
}

/**
 * Move one invoice's `amount_paid` by a RELATIVE amount and recompute its
 * status. Company-scoped.
 *
 * Relative, never absolute. The inline SQL this replaces read `amount_paid`,
 * added the allocation in JS and wrote the result back — two allocations
 * landing together both read the same value and the second erased the first.
 */
export async function applyLineToInvoice(
  companyId: string,
  line: ReceiptApplicationLine,
): Promise<void> {
  // MONEY ONLY. `status` and `paid_at` are derived by `recomputeInvoiceStatus`
  // from the balance this write leaves behind, so one function owns that rule.
  //
  // This statement used to set both inline, and had the WRONG half of each
  // pair: a bare `NOW()` re-dated a months-old settlement on any further write
  // to an already-paid invoice, and `ELSE paid_at` left a paid date on an
  // invoice that had REOPENED — which reads as evidence of a settlement that
  // has since been undone. The helper uses `COALESCE(paid_at, NOW())` and
  // `ELSE NULL`, which is the correct pair on both halves.
  //
  // BEHAVIOUR CHANGE, deliberate: delegating also picks up the helper's
  // `status = ANY(BALANCE_DERIVED)` guard, which this statement never had. A
  // payment figure can no longer move a `disputed`, `cancelled` or
  // `written_off` invoice to 'paid' — it is not evidence about any of them.
  await sql`
    UPDATE customer_invoices
    SET amount_paid = COALESCE(amount_paid, 0) + ${line.amount},
        updated_at = NOW()
    WHERE id = ${line.invoiceId}::UUID AND company_id = ${companyId}::UUID
  `;
  await recomputeInvoiceStatus(companyId, 'customer', line.invoiceId);
}
