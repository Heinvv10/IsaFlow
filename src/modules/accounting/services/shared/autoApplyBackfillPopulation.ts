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
 * remainder is `total_amount - applied_amount`, which migration 677 makes the
 * sum of the note's `credit_note_allocations` rows.
 *
 * EVERY SKIP IS DECIDED HERE, in both modes, for the reason on
 * `BackfillSource.skippedReason`: a dry run that plans what a live run withholds
 * is not a preview. There are four, and each is a fact about the source rather
 * than about the attempt — an unresolvable contact, a journal in no fiscal
 * period, no journal at all, and a status the application service refuses.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { getUnappliedPaymentBasis } from './unappliedPaymentBasis';
import { creditNoteForeignCurrencySql } from './documentCurrency';
import { fetchOpenSupplierBills } from '../ap/openSupplierBills';
import { fetchOpenCustomerInvoices } from '../ar/openCustomerInvoices';
import { journalsInAPeriod } from './journalPeriodVisibility';
import { EPS } from './autoAllocateStrategy';
import {
  basisSources, markCreditCeilingSkips, SKIP_NO_FISCAL_PERIOD, SKIP_NO_JOURNAL,
} from './autoApplyBackfillSkips';
import type { SimulationDocument } from './autoApplySimulation';
import type { BackfillSource, Subledger } from './autoApplyBackfillPlan';


/**
 * Credit-note statuses that still carry an unapplied remainder.
 *
 * 'partially_applied' arrives with migration 677 and is the state a note spread
 * over some but not all of its face value is in — exactly the note this
 * back-fill exists to finish. 'applied' is excluded
 * deliberately: a note that says it is fully applied and still shows a
 * remainder is a data fault to be investigated, not cash to move automatically.
 */
const CREDIT_NOTE_STATUSES = ['approved', 'partially_applied'];

/** `credit_notes.type` for each subledger. */
const CREDIT_NOTE_TYPE: Record<Subledger, string> = { ap: 'supplier', ar: 'customer' };

async function readCreditNotes(
  companyId: string,
  subledger: Subledger,
  entityId: string | null,
  limit: number,
): Promise<BackfillSource[]> {
  const isAp = subledger === 'ap';
  const rows = (isAp
    ? await sql`
        SELECT cn.id, cn.credit_note_number, cn.credit_date, cn.gl_journal_entry_id,
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
          AND NOT ${creditNoteForeignCurrencySql()}
        ORDER BY cn.credit_date ASC, cn.credit_note_number ASC, cn.id ASC
        LIMIT ${limit}`
    : await sql`
        SELECT cn.id, cn.credit_note_number, cn.credit_date, cn.gl_journal_entry_id,
               cn.client_id AS entity_id, c.name AS entity_name,
               (cn.total_amount - COALESCE(cn.applied_amount, 0)) AS remainder
        FROM credit_notes cn
        JOIN customers c ON c.id = cn.client_id
         AND c.company_id = cn.company_id AND c.deleted_at IS NULL
        WHERE cn.company_id = ${companyId}::UUID
          AND cn.type = ${CREDIT_NOTE_TYPE[subledger]}
          AND cn.status = ANY(${CREDIT_NOTE_STATUSES}::TEXT[])
          AND (cn.total_amount - COALESCE(cn.applied_amount, 0)) > 0
          AND (${entityId}::UUID IS NULL OR cn.client_id = ${entityId}::UUID)
          AND NOT ${creditNoteForeignCurrencySql()}
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
    journalEntryId: r.gl_journal_entry_id ? String(r.gl_journal_entry_id) : null,
    skippedReason: null,
  }));
}

/**
 * Every unapplied payment and credit note for this subledger, OLDEST FIRST,
 * each already carrying the reason it may not be applied when there is one.
 *
 * Oldest first is the whole ordering contract: the run applies the oldest cash
 * to the oldest document, so a later source sees what an earlier one consumed.
 * `payment_date`, then the human-readable number, then the id — the id is there
 * because two same-day payments with the same number would otherwise be left in
 * heap order and two runs over the same books could settle different documents.
 *
 * `limit` caps the MERGED list, applied after the merge: a company whose 500
 * oldest sources are all credit notes must not have its payments displaced by
 * an evenly split budget.
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
  // THE BASIS IS UNPAGED — it returns every unapplied payment on the side, and
  // its callers page it. So `entityId` is applied HERE, in memory, over a
  // complete list: exact, and without a second copy of the predicate in SQL.
  // Pushing the filter down into the shared query would also have to reach its
  // separate totals aggregate, or the envelope's completeness identity would
  // describe the whole book while the rows described one contact.
  const basis = await getUnappliedPaymentBasis(companyId, subledger, asAt);
  const merged: BackfillSource[] = basisSources(subledger, basis.rows)
    .filter((s) => entityId === null || s.entityId === entityId);
  merged.push(...await readCreditNotes(companyId, subledger, entityId, limit));

  const ordered = merged
    .sort((a, b) => (
      a.paymentDate.localeCompare(b.paymentDate)
      || a.paymentNumber.localeCompare(b.paymentNumber)
      || a.paymentId.localeCompare(b.paymentId)
    ))
    .slice(0, limit);

  // The credit ceiling AFTER the period skip: a withheld source consumes no credit.
  return markCreditCeilingSkips(subledger, basis.rows, await markJournalPeriodSkips(companyId, ordered));
}

/**
 * The fiscal-period skip, for every source at once.
 *
 * A document must not be marked paid off a journal that appears in no
 * period-scoped report — the guard the live FIFO path applies before it applies
 * anything (shared/journalPeriodVisibility). Deciding it HERE rather than at
 * write time is what makes the dry run agree with the live run: a payment
 * planned as applying and then withheld does not merely misstate itself, it
 * hands every later payment against that contact a set of balances that were
 * never consumed.
 *
 * A source with no journal at all is withheld too. Cash on a posted payment
 * with no journal is a data fault, and guessing which is the safe reading of a
 * fault is how faults get spread.
 */
async function markJournalPeriodSkips(
  companyId: string,
  sources: readonly BackfillSource[],
): Promise<BackfillSource[]> {
  const toCheck = sources
    .filter((s) => !s.skippedReason && s.journalEntryId)
    .map((s) => s.journalEntryId!);
  const inPeriod = await journalsInAPeriod(companyId, toCheck);
  return sources.map((source) => {
    if (source.skippedReason) return source;
    if (!source.journalEntryId) return { ...source, skippedReason: SKIP_NO_JOURNAL };
    return inPeriod.has(source.journalEntryId)
      ? source
      : { ...source, skippedReason: SKIP_NO_FISCAL_PERIOD };
  });
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
 * The number and `invoice_date` for the documents a plan names, which the
 * open-document readers do not both return. Read in ONE statement for the whole
 * plan rather than per line: a 500-source back-fill names thousands.
 */
export async function fetchDocumentFacts(
  companyId: string,
  subledger: Subledger,
  documentIds: readonly string[],
): Promise<Map<string, { invoiceNumber: string; invoiceDate: string }>> {
  if (documentIds.length === 0) return new Map();
  const ids = [...new Set(documentIds)];
  const rows = (subledger === 'ap'
    ? await sql`
        SELECT id, invoice_number, invoice_date FROM supplier_invoices
        WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[])`
    : await sql`
        SELECT id, invoice_number, invoice_date FROM customer_invoices
        WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[])`) as DbRow[];
  return new Map(rows.map((r) => [String(r.id), {
    invoiceNumber: r.invoice_number ? String(r.invoice_number) : String(r.id),
    invoiceDate: fmtDate(r.invoice_date),
  }]));
}
