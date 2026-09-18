/**
 * A supplier's open bills, in the order cash will consume them.
 *
 * `total_amount - COALESCE(amount_paid, 0)` rather than the generated `balance`
 * column: the same arithmetic every other outstanding figure in this codebase
 * is derived from, so an auto-allocation cannot disagree with the aging report
 * about what is open.
 *
 * THE LOCK IS THE CALLER'S CHOICE, and it is the reason this lives in its own
 * file. The live path consumes these rows, so it must hold them: without
 * `FOR UPDATE` two concurrent payments to one supplier each plan their whole
 * amount against the same bill, and the second is refused by
 * `supplierAllocationLines` mid-allocation — which rolls back its journal, not
 * merely its application. The bulk `dry_run` reads the identical rows and
 * writes nothing; reusing the locking fetch made a PREVIEW hold row locks to
 * the end of its request, blocking every real allocation against those
 * suppliers while an agent thought about a batch.
 *
 * FOUR STATEMENTS, NOT ONE BUILT FROM STRINGS. Direction and lock are the only
 * things that vary and neither may ever be interpolated into SQL.
 *
 * The tie-breakers are part of the contract, not decoration. `invoice_date`
 * alone leaves same-day bills in heap order, so "oldest first" would mean
 * "whichever row the planner happened to reach first" and two runs over the
 * same books could settle different bills.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { EPS } from '../shared/autoAllocateStrategy';
import type { SimulationDocument } from '../shared/autoApplySimulation';

/**
 * Bill statuses that cannot take a payment. Deliberately the same set
 * `supplierAllocationLines#buildLine` refuses on, plus the terminal ones there
 * is no point selecting: an auto-allocation that planned a line the applier
 * then threw on would roll back a journal over a bill nobody asked to pay.
 *
 * 'disputed' is in `supplier_invoices`' CHECK constraint (migration 201) and is
 * the one the automatic path most needs: cash must not quietly settle a bill
 * the company is contesting. 'written_off' is not in that constraint and so
 * never matches — kept because the AR twin's table does carry it and one list
 * that is wrong in the harmless direction beats two lists that disagree.
 */
export const UNALLOCATABLE_BILL_STATUSES = [
  'draft', 'cancelled', 'paid', 'written_off', 'disputed',
];

export interface OpenDocumentFetchOptions {
  /**
   * True to hold every candidate row for the rest of the request. Stated by
   * every caller rather than defaulted, because the two callers want opposite
   * answers and a default would silently give one of them the wrong one.
   */
  forUpdate: boolean;
}

export async function fetchOpenSupplierBills(
  companyId: string,
  supplierId: string,
  oldestFirst: boolean,
  opts: OpenDocumentFetchOptions,
): Promise<SimulationDocument[]> {
  const rows = (oldestFirst
    ? (opts.forUpdate
      ? await sql`
          SELECT id, invoice_number, (total_amount - COALESCE(amount_paid, 0)) AS outstanding
          FROM supplier_invoices
          WHERE company_id = ${companyId}::UUID
            AND supplier_id = ${supplierId}::UUID
            AND deleted_at IS NULL
            AND status <> ALL(${UNALLOCATABLE_BILL_STATUSES}::TEXT[])
            AND (total_amount - COALESCE(amount_paid, 0)) > ${EPS}
          ORDER BY invoice_date ASC, due_date ASC NULLS LAST, id ASC
          FOR UPDATE`
      : await sql`
          SELECT id, invoice_number, (total_amount - COALESCE(amount_paid, 0)) AS outstanding
          FROM supplier_invoices
          WHERE company_id = ${companyId}::UUID
            AND supplier_id = ${supplierId}::UUID
            AND deleted_at IS NULL
            AND status <> ALL(${UNALLOCATABLE_BILL_STATUSES}::TEXT[])
            AND (total_amount - COALESCE(amount_paid, 0)) > ${EPS}
          ORDER BY invoice_date ASC, due_date ASC NULLS LAST, id ASC`)
    : (opts.forUpdate
      ? await sql`
          SELECT id, invoice_number, (total_amount - COALESCE(amount_paid, 0)) AS outstanding
          FROM supplier_invoices
          WHERE company_id = ${companyId}::UUID
            AND supplier_id = ${supplierId}::UUID
            AND deleted_at IS NULL
            AND status <> ALL(${UNALLOCATABLE_BILL_STATUSES}::TEXT[])
            AND (total_amount - COALESCE(amount_paid, 0)) > ${EPS}
          ORDER BY invoice_date DESC, due_date DESC NULLS FIRST, id DESC
          FOR UPDATE`
      : await sql`
          SELECT id, invoice_number, (total_amount - COALESCE(amount_paid, 0)) AS outstanding
          FROM supplier_invoices
          WHERE company_id = ${companyId}::UUID
            AND supplier_id = ${supplierId}::UUID
            AND deleted_at IS NULL
            AND status <> ALL(${UNALLOCATABLE_BILL_STATUSES}::TEXT[])
            AND (total_amount - COALESCE(amount_paid, 0)) > ${EPS}
          ORDER BY invoice_date DESC, due_date DESC NULLS FIRST, id DESC`)) as DbRow[];

  return rows.map((r) => ({
    invoiceId: String(r.id),
    invoiceNumber: r.invoice_number ? String(r.invoice_number) : String(r.id),
    outstanding: Number(r.outstanding),
  }));
}
