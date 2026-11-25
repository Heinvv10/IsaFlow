/**
 * A supplier merge and POSTED documents (ruling for Hein, 2026-11-25): a merge moves the source's posted documents onto the
 * survivor only for a person who holds Suppliers Approve (User Access; approvePermission.mayApprove). Without it the merge is
 * refused, ApprovePermissionError (403 on the routes), before anything moves; a merge of suppliers with only draft documents still
 * goes through.
 *
 * Posted, by document (the populations the ledger already uses):
 *   - bills: approved, partially_paid, paid (APPROVED_BILL_STATUSES: each carries its posted journal);
 *   - payments: processed, reconciled (the journal posted at process);
 *   - supplier credit notes: approved, partially_applied, applied (the note's journal posts at approval, so an approved one counts);
 *   - purchase orders past submitted (approved, partially received, received, closed: a commitment; a cancelled one commits nothing).
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
export const POSTED_PAYMENT_STATUSES: readonly string[] = ['processed', 'reconciled'];
export const POSTED_CREDIT_NOTE_STATUSES: readonly string[] = ['approved', 'partially_applied', 'applied'];
const UNCOMMITTED_PO_STATUSES: readonly string[] = ['draft', 'submitted', 'cancelled'];

export type PostedKind = 'bill' | 'payment' | 'credit_note' | 'purchase_order';
const NOUN: Record<PostedKind, [string, string]> = {
  bill: ['approved, partly paid or paid bill', 'approved, partly paid or paid bills'],
  payment: ['processed or reconciled payment', 'processed or reconciled payments'],
  credit_note: ['approved or applied credit note', 'approved or applied credit notes'],
  purchase_order: ['approved or received purchase order', 'approved or received purchase orders'],
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
          AND status = ANY(${POSTED_BILL_STATUSES}::TEXT[]))::INT AS bills,
      (SELECT count(*) FROM supplier_payments WHERE company_id = ${companyId}::UUID AND supplier_id = ${sourceId}::UUID
          AND status = ANY(${POSTED_PAYMENT_STATUSES}::TEXT[]))::INT AS payments,
      (SELECT count(*) FROM credit_notes WHERE company_id = ${companyId}::UUID AND supplier_id = ${sourceId}::UUID
          AND status = ANY(${POSTED_CREDIT_NOTE_STATUSES}::TEXT[]))::INT AS notes
  `) as DbRow[];
  const counts = {
    bill: Number(row?.bills ?? 0), payment: Number(row?.payments ?? 0), credit_note: Number(row?.notes ?? 0),
    purchase_order: pos.filter((p) => !UNCOMMITTED_PO_STATUSES.includes(p.status)).length,
  };
  if (Object.values(counts).some((n) => n > 0)) throw refusal(counts);
}

/** On a document UPDATE's RETURNING rows (each with its `status`): refused when the person may not move a posted one (see above). */
export function refuseIfMovedPosted(moved: ReadonlyArray<Record<string, unknown>>, kind: PostedKind, mayMovePosted: boolean): void {
  if (mayMovePosted) return;
  const posted = kind === 'bill' ? POSTED_BILL_STATUSES : kind === 'payment' ? POSTED_PAYMENT_STATUSES : POSTED_CREDIT_NOTE_STATUSES;
  const n = moved.filter((r) => posted.includes(String(r.status))).length;
  if (n > 0) throw refusal({ [kind]: n });
}
