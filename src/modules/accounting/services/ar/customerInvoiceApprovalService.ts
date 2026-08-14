/**
 * Customer Invoice Approval Service
 *
 * The 'approve' action of pages/api/accounting/customer-invoices-detail.ts,
 * extracted verbatim so the MCP write-tool layer calls the SAME code the
 * HTTP route uses — the guarded draft/pending_approval → approved status
 * transition, GL posting, and PDF evidence sealing are not duplicated.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentService';
import { snapshotInvoicePdf } from '@/modules/accounting/services/ar/invoicePdfSnapshotService';

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
  opts?: { postingAgent?: string },
): Promise<ApproveCustomerInvoiceResult> {
  // Guard the transition in the UPDATE: only draft/pending_approval invoices
  // may be approved. Re-approving a cancelled invoice would re-add it to AR
  // while its journal is already reversed to net zero (AR != GL).
  const approved = (await sql`
    UPDATE customer_invoices
    SET status = 'approved', updated_at = NOW()
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}
      AND status = ANY(${APPROVABLE_STATUSES}::text[])
    RETURNING id
  `) as Row[];
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
    const snapshot = await snapshotInvoicePdf(companyId, invoiceId);
    evidenceDocumentId = snapshot.documentId;
    log.info('Customer invoice PDF snapshot sealed', {
      id: invoiceId, documentId: snapshot.documentId, wasExisting: snapshot.wasExisting,
    });
  } catch (snapErr) {
    log.error('PDF snapshot failed (invoice still transitioned)', { id: invoiceId, error: snapErr });
  }

  return { id: invoiceId, status: 'approved', glJournalEntryId, evidenceDocumentId };
}
