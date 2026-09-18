/**
 * The population the back-fill works over, and the open documents it would
 * consume.
 *
 * THE DEFINITION OF "UNAPPLIED" IS NOT RESTATED HERE. `getUnappliedPayments`
 * and `getUnappliedReceipts` already own it — which statuses count as posted
 * cash, how a remainder is derived from the live allocation table, and which
 * contact rows resolve — and they are what `list_unapplied_payments` /
 * `list_unapplied_receipts` report. A second copy of that predicate would let
 * the back-fill act on a population the report does not show, which is the one
 * thing an operator checking the tool's work cannot tolerate. Both were given
 * an optional `entityId` for this caller; nothing else changed.
 *
 * CREDIT NOTES ARE READ HERE, because no shared reader exists for them. Their
 * remainder is `total_amount - applied_amount` (migration 529), and the
 * `credit_notes` CHECK constraint from migration 202 admits only
 * draft/approved/applied/cancelled — see the note on `CREDIT_NOTE_STATUSES`.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { getUnappliedPayments } from '../ap/unappliedPaymentService';
import { getUnappliedReceipts } from '../ar/unappliedReceiptService';
import { fetchOpenSupplierBills } from '../ap/openSupplierBills';
import { fetchOpenCustomerInvoices } from '../ar/openCustomerInvoices';
import { EPS } from './autoAllocateStrategy';
import type { SimulationDocument } from './autoApplySimulation';
import type { BackfillSource, Subledger } from './autoApplyBackfillPlan';

/**
 * Credit-note statuses that still carry an unapplied remainder.
 *
 * 'partially_applied' is NOT in migration 202's CHECK constraint and therefore
 * matches no row on this branch — it is listed because the credit-note FIFO
 * work introduces it, and a list that names only 'approved' would silently stop
 * seeing part-applied notes the day that status exists. 'applied' is excluded
 * deliberately: a note that says it is fully applied and still shows a
 * remainder is a data fault to be investigated, not cash to move automatically.
 */
const CREDIT_NOTE_STATUSES = ['approved', 'partially_applied'];

/** `credit_notes.type` for each subledger. */
const CREDIT_NOTE_TYPE: Record<Subledger, string> = { ap: 'supplier', ar: 'customer' };

/**
 * Whether this database has the table a credit-note application writes to.
 *
 * Checked at RUNTIME rather than assumed: `credit_note_allocations` arrives
 * with the credit-note FIFO work, and this tool has to be honest on a database
 * that does not have it yet — the dry run still shows what the notes would
 * settle, and the live run refuses them by name instead of throwing an
 * undefined-table error halfway through a backlog.
 */
export async function creditNoteAllocationsExist(): Promise<boolean> {
  const rows = (await sql`
    SELECT to_regclass('public.credit_note_allocations') IS NOT NULL AS present
  `) as DbRow[];
  return Boolean(rows[0]?.present);
}

/** The reason a credit note carries when this database cannot record one. */
export const CREDIT_NOTE_TABLE_MISSING = 'credit_note_allocations table not present';

async function readCreditNotes(
  companyId: string,
  subledger: Subledger,
  entityId: string | null,
  limit: number,
): Promise<BackfillSource[]> {
  const isAp = subledger === 'ap';
  const rows = (isAp
    ? await sql`
        SELECT cn.id, cn.credit_note_number, cn.credit_date,
               cn.supplier_id AS entity_id, s.name AS entity_name,
               (cn.total_amount - COALESCE(cn.applied_amount, 0)) AS remainder
        FROM credit_notes cn
        JOIN suppliers s ON s.id = cn.supplier_id
         AND s.company_id = cn.company_id AND s.deleted_at IS NULL
        WHERE cn.company_id = ${companyId}::UUID
          AND cn.type = ${CREDIT_NOTE_TYPE[subledger]}
          AND cn.status = ANY(${CREDIT_NOTE_STATUSES}::TEXT[])
          AND (cn.total_amount - COALESCE(cn.applied_amount, 0)) > ${EPS}
          AND (${entityId}::UUID IS NULL OR cn.supplier_id = ${entityId}::UUID)
        ORDER BY cn.credit_date ASC, cn.credit_note_number ASC, cn.id ASC
        LIMIT ${limit}`
    : await sql`
        SELECT cn.id, cn.credit_note_number, cn.credit_date,
               cn.client_id AS entity_id, c.name AS entity_name,
               (cn.total_amount - COALESCE(cn.applied_amount, 0)) AS remainder
        FROM credit_notes cn
        JOIN customers c ON c.id = cn.client_id
         AND c.company_id = cn.company_id AND c.deleted_at IS NULL
        WHERE cn.company_id = ${companyId}::UUID
          AND cn.type = ${CREDIT_NOTE_TYPE[subledger]}
          AND cn.status = ANY(${CREDIT_NOTE_STATUSES}::TEXT[])
          AND (cn.total_amount - COALESCE(cn.applied_amount, 0)) > ${EPS}
          AND (${entityId}::UUID IS NULL OR cn.client_id = ${entityId}::UUID)
        ORDER BY cn.credit_date ASC, cn.credit_note_number ASC, cn.id ASC
        LIMIT ${limit}`) as DbRow[];

  return rows.map((r) => ({
    kind: 'credit_note' as const,
    paymentId: String(r.id),
    paymentNumber: r.credit_note_number ? String(r.credit_note_number) : '',
    entityId: String(r.entity_id),
    entityName: r.entity_name ? String(r.entity_name) : '',
    paymentDate: fmtDate(r.credit_date),
    remainder: Number(r.remainder),
  }));
}

/**
 * Every unapplied payment and credit note for this subledger, OLDEST FIRST.
 *
 * Oldest first is the whole ordering contract: the run applies the oldest cash
 * to the oldest bill, so a later payment sees what an earlier one consumed.
 * `payment_date`, then the human-readable number, then the id — the id is there
 * because two same-day payments with the same number would otherwise be left in
 * heap order and two runs over the same books could settle different documents.
 *
 * `limit` is a cap on the MERGED list, applied after the merge: a company whose
 * 500 oldest sources are all credit notes must not have its payments displaced
 * by an evenly split budget.
 */
export async function readBackfillSources(
  companyId: string,
  subledger: Subledger,
  entityId: string | null,
  limit: number,
): Promise<BackfillSource[]> {
  // As at TODAY. A back-fill acts on the books as they stand; an `asAt` in the
  // past would plan against a remainder later cash has already changed.
  const asAt = fmtDate(new Date());
  const payments: BackfillSource[] = subledger === 'ap'
    ? (await getUnappliedPayments(companyId, { asAt, limit, entityId })).rows
      .filter((r) => r.supplierId !== null)
      .map((r) => ({
        kind: 'payment' as const,
        paymentId: r.paymentId,
        paymentNumber: r.paymentNumber,
        entityId: r.supplierId!,
        entityName: r.supplierName ?? '',
        paymentDate: r.paymentDate,
        remainder: r.unappliedAmount,
      }))
    : (await getUnappliedReceipts(companyId, { asAt, limit, entityId })).rows
      .filter((r) => r.customerId !== null)
      .map((r) => ({
        kind: 'payment' as const,
        paymentId: r.paymentId,
        paymentNumber: r.paymentNumber,
        entityId: r.customerId!,
        entityName: r.customerName ?? '',
        paymentDate: r.paymentDate,
        remainder: r.unappliedAmount,
      }));

  const notes = await readCreditNotes(companyId, subledger, entityId, limit);
  return [...payments, ...notes]
    .sort((a, b) => (
      a.paymentDate.localeCompare(b.paymentDate)
      || a.paymentNumber.localeCompare(b.paymentNumber)
      || a.paymentId.localeCompare(b.paymentId)
    ))
    .slice(0, limit);
}

/**
 * One entity's open documents, through the SAME readers the live FIFO path
 * uses — eligible statuses and the ordering contract come from there rather
 * than being restated.
 *
 * `forUpdate` is STATED by each caller, never defaulted: a live run is about to
 * consume these rows and must hold them, while a dry run must not lock a whole
 * subledger's open documents for the length of a preview it throws away.
 */
export function fetchOpenDocuments(
  companyId: string,
  subledger: Subledger,
  entityId: string,
  oldestFirst: boolean,
  forUpdate: boolean,
): Promise<SimulationDocument[]> {
  return subledger === 'ap'
    ? fetchOpenSupplierBills(companyId, entityId, oldestFirst, { forUpdate })
    : fetchOpenCustomerInvoices(companyId, entityId, oldestFirst, { forUpdate });
}

/**
 * `invoice_date` for the documents a plan names, which the open-document
 * readers do not select. Read in one statement for the whole plan rather than
 * per line: a 500-payment back-fill names thousands of documents.
 */
export async function fetchDocumentDates(
  companyId: string,
  subledger: Subledger,
  documentIds: readonly string[],
): Promise<Map<string, string>> {
  if (documentIds.length === 0) return new Map();
  const ids = [...new Set(documentIds)];
  const rows = (subledger === 'ap'
    ? await sql`
        SELECT id, invoice_date FROM supplier_invoices
        WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[])`
    : await sql`
        SELECT id, invoice_date FROM customer_invoices
        WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[])`) as DbRow[];
  return new Map(rows.map((r) => [String(r.id), fmtDate(r.invoice_date)]));
}
