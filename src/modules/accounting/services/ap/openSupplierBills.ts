/**
 * A supplier's open bills, in the order cash will consume them.
 *
 * `total_amount - COALESCE(amount_paid, 0)` rather than the generated `balance`
 * column: the same arithmetic every other outstanding figure in this codebase
 * is derived from, so an auto-allocation cannot disagree with the aging report
 * about what is open.
 *
 * ── THE ELIGIBLE SET IS POSITIVE ────────────────────────────────────────────
 *
 * `FIFO_ELIGIBLE_STATUSES` names what cash MAY settle, and it is the same
 * constant `recomputeInvoiceStatus` is gated on. It began as a list of
 * exclusions and that list forgot `pending_approval`: the walk settled an
 * unapproved bill, the recompute then refused to touch a row outside
 * `BALANCE_DERIVED`, and the bill was left at `amount_paid = total_amount`
 * under status `pending_approval` with `payment_matched` false — a state no
 * writer in the codebase corrects, because every writer of those columns is
 * gated on the same set. An allow-list cannot have that hole.
 *
 * ── THE LOCK ORDER IS ID, NOT FIFO ──────────────────────────────────────────
 *
 * Rows are locked `ORDER BY id`, which is the canonical lock order on this path
 * (`supplierAllocationLines#lockBillCandidates`, `receiptAllocationLines`), and
 * the FIFO ordering is applied in memory afterwards. Locking in
 * (invoice_date, due_date, id) order instead meant two requests could take the
 * same two bills in opposite sequences and deadlock — 40P01, which aborts the
 * whole transaction and, in a bulk batch, every line already posted beside it.
 *
 * A timeout or a deadlock is a REFUSAL, raised before this path writes
 * anything and marked `retryable` so a caller can answer 409 rather than 400 —
 * the same shape, the same wording and the same `isLockContention` mapping the
 * allocation-line helpers use.
 *
 * ── THE LOCK IS THE CALLER'S CHOICE ─────────────────────────────────────────
 *
 * The live path consumes these rows, so it holds them: without `FOR UPDATE`
 * two concurrent payments to one supplier each plan their whole amount against
 * the same bill, and the second is refused by `supplierAllocationLines`
 * mid-allocation — which rolls back its journal, not merely its application.
 * The bulk `dry_run` reads the identical rows and writes nothing; reusing the
 * locking fetch made a PREVIEW hold row locks to the end of its request,
 * blocking every real allocation against those suppliers while an agent
 * thought about a batch.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { EPS } from '../shared/autoAllocateStrategy';
import type { SimulationDocument } from '../shared/autoApplySimulation';
import { FIFO_ELIGIBLE_STATUSES } from '../ar/invoiceStatusRecompute';
import { requireRequestTransaction } from '../core/requestTransaction';
import { isLockContention } from '../core/lockContention';
import { SupplierPaymentRefusal } from './supplierPaymentRefusal';
import { orderOpenDocuments, type OpenDocumentRow } from '../shared/openDocumentOrder';

export interface OpenDocumentFetchOptions {
  /**
   * True to hold every candidate row for the rest of the request. Stated by
   * every caller rather than defaulted, because the two callers want opposite
   * answers and a default would silently give one of them the wrong one.
   */
  forUpdate: boolean;
}

function toRows(rows: DbRow[]): OpenDocumentRow[] {
  return rows.map((r) => ({
    invoiceId: String(r.id),
    invoiceNumber: r.invoice_number ? String(r.invoice_number) : String(r.id),
    outstanding: Number(r.outstanding),
    invoiceDate: r.invoice_date instanceof Date
      ? r.invoice_date.toISOString().slice(0, 10)
      : String(r.invoice_date ?? ''),
    dueDate: r.due_date === null || r.due_date === undefined
      ? null
      : (r.due_date instanceof Date ? r.due_date.toISOString().slice(0, 10) : String(r.due_date)),
  }));
}

export async function fetchOpenSupplierBills(
  companyId: string,
  supplierId: string,
  oldestFirst: boolean,
  opts: OpenDocumentFetchOptions,
): Promise<SimulationDocument[]> {
  // Two statements, never one built from strings: the lock is the only thing
  // that varies, and the ORDER BY is fixed because ordering happens in memory.
  const read = async (): Promise<DbRow[]> => (opts.forUpdate
    ? await sql`
        SELECT id, invoice_number, invoice_date, due_date,
               (total_amount - COALESCE(amount_paid, 0)) AS outstanding
        FROM supplier_invoices
        WHERE company_id = ${companyId}::UUID
          AND supplier_id = ${supplierId}::UUID
          AND deleted_at IS NULL
          AND status = ANY(${[...FIFO_ELIGIBLE_STATUSES]}::TEXT[])
          AND (total_amount - COALESCE(amount_paid, 0)) > ${EPS}
        ORDER BY id
        FOR UPDATE`
    : await sql`
        SELECT id, invoice_number, invoice_date, due_date,
               (total_amount - COALESCE(amount_paid, 0)) AS outstanding
        FROM supplier_invoices
        WHERE company_id = ${companyId}::UUID
          AND supplier_id = ${supplierId}::UUID
          AND deleted_at IS NULL
          AND status = ANY(${[...FIFO_ELIGIBLE_STATUSES]}::TEXT[])
          AND (total_amount - COALESCE(amount_paid, 0)) > ${EPS}
        ORDER BY id`) as DbRow[];

  if (!opts.forUpdate) return orderOpenDocuments(toRows(await read()), oldestFirst);

  // Bounded, like every other lock on this path: an unbounded wait behind a
  // peer holding one bill stalls the whole request rather than refusing it.
  const client = requireRequestTransaction('fetchOpenSupplierBills');
  await client.query("SET LOCAL lock_timeout = '5s'");
  try {
    const rows = await read();
    await client.query('SET LOCAL lock_timeout = DEFAULT');
    return orderOpenDocuments(toRows(rows), oldestFirst);
  } catch (err) {
    // Deliberately NOT in a `finally`: after a timeout the transaction is
    // aborted and restoring the default would itself raise 25P02, replacing the
    // typed refusal with an opaque error. Same reasoning as lockBillCandidates.
    if (isLockContention(err)) {
      throw new SupplierPaymentRefusal(
        'Another request is paying one of these bills — retry in a moment.',
        { retryable: true, held: true },
      );
    }
    throw err;
  }
}
