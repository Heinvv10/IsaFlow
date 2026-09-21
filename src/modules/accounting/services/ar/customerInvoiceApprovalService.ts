/**
 * Customer Invoice Approval Service
 *
 * The 'approve' action of pages/api/accounting/customer-invoices-detail.ts,
 * extracted verbatim so the MCP write-tool layer calls the SAME code the
 * HTTP route uses — the guarded draft/pending_approval → approved status
 * transition, GL posting, and PDF evidence sealing are not duplicated.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { als, assertTxUsable } from '@/lib/als';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentService';
import { snapshotInvoicePdf } from '@/modules/accounting/services/ar/invoicePdfSnapshotService';
import type { PostingActorOpts } from '../gl/journalEntryMeta';

type Row = DbRow;

// Only pre-approval invoices may be approved. Re-approving a later-state invoice
// (e.g. one already cancelled) would put it back in AR while its journal is the
// reversed net-zero pair (AR != GL) — see the approve guard below.
const APPROVABLE_STATUSES = ['draft', 'pending_approval'];

/**
 * Thrown when the invoice cannot be approved: either it does not belong to
 * the company (`notFound: true`, maps to a 404 at the route) or it exists
 * but is not in an approvable status (maps to a 400).
 */
/** Postgres `lock_not_available` — `lock_timeout` elapsed waiting for the row. */
const LOCK_NOT_AVAILABLE = '55P03';

function isLockTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as { code?: unknown }).code === LOCK_NOT_AVAILABLE;
}

/**
 * Raised when another request holds the invoice row longer than the 5s
 * `lock_timeout`. Carries a stable `code` so the bulk runner can treat it as a
 * retryable skip without importing an AR service to compare constructors.
 *
 * ONE class, defined in `customerInvoiceLock.ts` and re-exported here. This
 * file used to declare a SECOND class carrying the same
 * `CUSTOMER_INVOICE_LOCK_TIMEOUT` code, so `bulkApproveRunner`'s retryable-skip
 * list matched both while nothing could tell an approval-path timeout from an
 * apply-path one. They mean the same thing — this invoice's row is held — so
 * they are the same error.
 */
import { CustomerInvoiceLockTimeoutError } from './customerInvoiceLock';

export { CustomerInvoiceLockTimeoutError };

export class InvoiceNotApprovableError extends Error {
  public readonly notFound: boolean;

  constructor(message: string, notFound = false) {
    super(message);
    this.name = 'InvoiceNotApprovableError';
    this.notFound = notFound;
  }
}

export interface ApproveCustomerInvoiceResult {
  id: string;
  status: string;
  glJournalEntryId: string | null;
  /**
   * PRD-06 evidence seal from snapshotInvoicePdf. Not part of the minimal
   * { id, status, glJournalEntryId } contract callers key off of, but kept
   * on the result so the HTTP route's existing response shape (which has
   * always included evidenceDocumentId) does not change.
   */
  evidenceDocumentId: string | null;
}

/**
 * @param opts.postingAgent Stamp for the GL journal approval posts. Optional
 *   and last-positional: the HTTP route (a human clicking Approve) omits it
 *   and keeps `human:<userId>`; the MCP finalize_invoice tool passes its own
 *   stamp so agent-approved invoices show up in list_agent_postings.
 */
export async function approveCustomerInvoice(
  companyId: string,
  invoiceId: string,
  userId: string,
  opts?: PostingActorOpts,
): Promise<ApproveCustomerInvoiceResult> {
  // A COMPARE-AND-SWAP IS STRONGER THAN A LOCK AGAINST DOUBLE-POSTING, AND
  // WEAKER AGAINST HANGING. The guarded UPDATE below means two callers cannot
  // both win, so no lock is needed to stop a second journal — but the loser
  // does not get "matched zero rows": it BLOCKS on the winner's row lock for as
  // long as the winner's transaction runs. With bulk_finalize_invoices that is
  // up to 100 invoices, each rendering and uploading a PDF, so the wait is the
  // whole batch. Nothing sets lock_timeout globally, so without this the wait
  // is unbounded and an agent retrying an apparently-hung call piles on.
  //
  // 5s matches the two row locks (bankTxLock, creditNoteLock, and now
  // supplierInvoiceLock) so every approve path answers contention the same way,
  // and the bulk runner turns the typed timeout into a retryable per-element
  // skip rather than a failed batch. Re-issued per call, never memoised:
  // SET LOCAL is subtransaction-aware and a savepoint rollback restores it to
  // 0 — no timeout at all — and every bulk element runs in its own savepoint.
  const client = als.getStore()?.client;
  if (client) {
    assertTxUsable();
    await client.query("SET LOCAL lock_timeout = '5s'");
  }

  // Guard the transition in the UPDATE: only draft/pending_approval invoices
  // may be approved. Re-approving a cancelled invoice would re-add it to AR
  // while its journal is already reversed to net zero (AR != GL).
  let approved: Row[];
  try {
    approved = (await sql`
    UPDATE customer_invoices
    SET status = 'approved', updated_at = NOW()
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}
      AND status = ANY(${APPROVABLE_STATUSES}::text[])
      RETURNING id
    `) as Row[];
  } catch (err) {
    if (isLockTimeout(err)) throw new CustomerInvoiceLockTimeoutError(`Customer invoice ${invoiceId}`);
    throw err;
  }
  // Restored on the SUCCESS path only — after a lock timeout the transaction is
  // aborted and this statement would itself raise 25P02, replacing the typed
  // error with an opaque one (creditNoteLock.test.ts pins that mistake).
  if (client) await client.query('SET LOCAL lock_timeout = DEFAULT');
  if (approved.length === 0) {
    const cur = (await sql`SELECT status FROM customer_invoices WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}`) as Row[];
    if (cur.length === 0) throw new InvoiceNotApprovableError(`Invoice ${invoiceId} not found`, true);
    throw new InvoiceNotApprovableError(`Cannot approve an invoice with status '${String(cur[0]!.status)}'`);
  }

  // Post to GL on approve (accrual accounting: DR AR, CR Revenue, CR VAT Output).
  //
  // This must NOT be swallowed. A caught failure used to leave the invoice
  // 'approved' — and therefore in AR — with gl_journal_entry_id NULL and no
  // journal behind it, so AR and the GL disagreed by the invoice total with
  // nothing surfacing the divergence. Letting it propagate matches the AP side
  // (supplierInvoiceWorkflowService.approveSupplierInvoice) and lets withAuth
  // roll the request transaction back, taking the status UPDATE above with it.
  const glJournalEntryId = await postCustomerInvoiceToGL(companyId, invoiceId, userId, opts);
  log.info('Customer invoice GL posted on approve', { id: invoiceId, glJournalEntryId });

  // PRD-06 Phase 1: seal the rendered PDF as evidence on approve.
  // Non-blocking: if storage is flaky the status transition still succeeds;
  // a later admin can re-trigger via POST /ar/invoice/[id]/pdf.
  let evidenceDocumentId: string | null = null;
  try {
    // WRAPPED IN ITS OWN SAVEPOINT, because "non-blocking" was not true inside a
    // shared transaction. snapshotInvoicePdf does real SQL (INSERT
    // captured_documents, then two UPDATEs), and a Postgres-level failure there
    // leaves the CONNECTION aborted. Catching the error then returns normally,
    // and the next statement on that connection — in a bulk approve, the
    // enclosing withSavepoint's own RELEASE SAVEPOINT — raises 25P02. The
    // element that failed was perfectly postable, and 99 good approvals die
    // with it. The savepoint makes the catch below mean what it says: the seal
    // is rolled back to a clean point and the status transition stands.
    const snapshot = await withSavepoint(
      'invoice_pdf_snapshot',
      () => snapshotInvoicePdf(companyId, invoiceId),
    );
    evidenceDocumentId = snapshot.documentId;
    log.info('Customer invoice PDF snapshot sealed', {
      id: invoiceId, documentId: snapshot.documentId, wasExisting: snapshot.wasExisting,
    });
  } catch (snapErr) {
    log.error('PDF snapshot failed (invoice still transitioned)', { id: invoiceId, error: snapErr });
  }

  return { id: invoiceId, status: 'approved', glJournalEntryId, evidenceDocumentId };
}
