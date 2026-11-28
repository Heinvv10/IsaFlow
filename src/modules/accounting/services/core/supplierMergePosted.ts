/**
 * A supplier merge and POSTED documents (ruling for Hein, 2026-11-25): a merge moves the source's posted documents onto the
 * survivor only for a person who holds Suppliers Approve (User Access; approvePermission.mayApprove). Without it the merge is
 * refused, ApprovePermissionError (403 on the routes), before anything moves; a merge of suppliers with only draft documents still
 * goes through.
 *
 * Posted, by document, on the safer side (breaker of #1900, M1 / M2): a posted status OR the marks a posting leaves, so a document
 * posted and then cancelled, voided, reversed or sent back to pending / disputed still counts (its journal pair moves with it):
 *   - bills: approved, partially_paid, paid; or a journal link, an approval stamp (approved_at / approved_by), or a journal sourced from it;
 *   - payments: approved (it will pay the payee's bank details), processed, reconciled; or in a payment batch, a journal link, an
 *     approval or process stamp, or a journal sourced from it;
 *   - supplier credit notes: approved, partially_applied, applied; or a journal link, an approval stamp, a journal sourced from it;
 *   - purchase orders: past submitted (approved, partially_received, received); or an approval stamp (approved, then cancelled).
 * Deleted documents count by their status too: a merge moves them as well.
 *
 * Decided under the merge's locks, both merge paths (core/duplicateMergeService.mergeSuppliers, pages/api/accounting/supplier-merge):
 *   - `assertMayMergePostedSupplierDocuments`, after both supplier rows are held FOR UPDATE and the source's POs are locked (their
 *     statuses are as locked); it reads the bills, payments and notes as committed and refuses when any is posted;
 *   - `refuseIfMovedPosted` on each document UPDATE's RETURNING: a draft approved, processed or applied while the merge waited on its
 *     row is moved by that UPDATE after the approver committed, so the merge refuses it there and its savepoint takes everything back.
 * The census (approvePostEntryCensus) treats `movePurchaseOrders` as a Suppliers sink and this assert as its gate.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { ApprovePermissionError, mayApprove } from './approvePermission';
import type { SourcePo } from './supplierMergePurchaseOrders';

export const POSTED_BILL_STATUSES: readonly string[] = ['approved', 'partially_paid', 'paid'];
export const POSTED_PAYMENT_STATUSES: readonly string[] = ['approved', 'processed', 'reconciled'];
export const POSTED_CREDIT_NOTE_STATUSES: readonly string[] = ['approved', 'partially_applied', 'applied'];
const UNCOMMITTED_PO_STATUSES: readonly string[] = ['draft', 'submitted', 'cancelled'];

const inList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ');
const sourcedJournal = (table: string) =>
  `EXISTS (SELECT 1 FROM gl_journal_entries je WHERE je.company_id = ${table}.company_id AND je.source_record_id = ${table}.id)`;
/**
 * "Posted" as a predicate on the row of each table, unaliased, so it serves both the pre-check (FROM <table>) and each move's
 * RETURNING (UPDATE <table> ... RETURNING <predicate> AS posted). Constants only: no caller value is spliced into the text.
 */
const POSTED_SQL = {
  bill: `(supplier_invoices.status IN (${inList(POSTED_BILL_STATUSES)}) OR supplier_invoices.gl_journal_entry_id IS NOT NULL
          OR supplier_invoices.approved_at IS NOT NULL OR supplier_invoices.approved_by IS NOT NULL OR ${sourcedJournal('supplier_invoices')})`,
  payment: `(supplier_payments.status IN (${inList(POSTED_PAYMENT_STATUSES)}) OR supplier_payments.batch_id IS NOT NULL
          OR supplier_payments.gl_journal_entry_id IS NOT NULL OR supplier_payments.approved_at IS NOT NULL OR supplier_payments.approved_by IS NOT NULL
          OR supplier_payments.processed_at IS NOT NULL OR ${sourcedJournal('supplier_payments')})`,
  credit_note: `(credit_notes.status IN (${inList(POSTED_CREDIT_NOTE_STATUSES)}) OR credit_notes.gl_journal_entry_id IS NOT NULL
          OR credit_notes.approved_at IS NOT NULL OR credit_notes.approved_by IS NOT NULL OR ${sourcedJournal('credit_notes')})`,
} as const;
/** The predicate for a move's RETURNING: `RETURNING ..., ${postedSql('bill')} AS posted`. */
export const postedSql = (kind: 'bill' | 'payment' | 'credit_note') => sql.unsafe(POSTED_SQL[kind]);

export type PostedKind = 'bill' | 'payment' | 'credit_note' | 'purchase_order';
const NOUN: Record<PostedKind, [string, string]> = {
  bill: ['approved, partly paid, paid or once-posted bill', 'approved, partly paid, paid or once-posted bills'],
  payment: ['approved, batched, processed or reconciled payment', 'approved, batched, processed or reconciled payments'],
  credit_note: ['approved, applied or once-posted credit note', 'approved, applied or once-posted credit notes'],
  purchase_order: ['approved, received or once-approved purchase order', 'approved, received or once-approved purchase orders'],
};

function refusal(counts: Partial<Record<PostedKind, number>>): ApprovePermissionError {
  const parts = (Object.keys(NOUN) as PostedKind[]).filter((k) => (counts[k] ?? 0) > 0)
    .map((k) => `${counts[k]} ${NOUN[k][counts[k] === 1 ? 0 : 1]}`);
  return new ApprovePermissionError('suppliers', `a supplier merge that moves posted documents (${parts.join(', ')})`);
}

/** Whether the merging person may move posted documents: Suppliers Approve (asked once, its answer passed to the checks below). */
export function mayMergePostedSupplierDocuments(companyId: string, userId: string): Promise<boolean> {
  return mayApprove(companyId, userId, 'suppliers');
}

/**
 * The gate (a statement of its own, as the census reads an assert). Without Suppliers Approve (`mayMovePosted` false) it refuses when
 * the source has any posted document; the caller's RETURNING checks (`refuseIfMovedPosted`) then refuse one posted meanwhile. Call it
 * after the merge holds both supplier rows and the source's purchase orders (`pos`, as locked).
 */
export async function assertMayMergePostedSupplierDocuments(
  companyId: string, sourceId: string, mayMovePosted: boolean, pos: readonly SourcePo[],
): Promise<void> {
  if (mayMovePosted) return;
  const [row] = (await sql`
    SELECT
      (SELECT count(*) FROM supplier_invoices WHERE company_id = ${companyId}::UUID AND supplier_id = ${sourceId}::UUID
          AND ${postedSql('bill')})::INT AS bills,
      (SELECT count(*) FROM supplier_payments WHERE company_id = ${companyId}::UUID AND supplier_id = ${sourceId}::UUID
          AND ${postedSql('payment')})::INT AS payments,
      (SELECT count(*) FROM credit_notes WHERE company_id = ${companyId}::UUID AND supplier_id = ${sourceId}::UUID
          AND ${postedSql('credit_note')})::INT AS notes
  `) as DbRow[];
  const counts = {
    bill: Number(row?.bills ?? 0), payment: Number(row?.payments ?? 0), credit_note: Number(row?.notes ?? 0),
    purchase_order: pos.filter((p) => !UNCOMMITTED_PO_STATUSES.includes(p.status) || p.approvedAt !== null || p.approvedBy !== null).length,
  };
  if (Object.values(counts).some((n) => n > 0)) throw refusal(counts);
}

/** On a document UPDATE's RETURNING rows (each with `posted`: `postedSql(kind)`): refused when the person may not move a posted one. */
export function refuseIfMovedPosted(moved: ReadonlyArray<Record<string, unknown>>, kind: PostedKind, mayMovePosted: boolean): void {
  if (mayMovePosted) return;
  const n = moved.filter((r) => r.posted === true).length;
  if (n > 0) throw refusal({ [kind]: n });
}
