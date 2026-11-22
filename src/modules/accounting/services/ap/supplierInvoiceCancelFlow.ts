/**
 * Supplier invoice cancel: reverses the approval journal (chain head, under the head lock) and flips the
 * status. Split out of supplierInvoiceWorkflowService.ts for file-size compliance; that module re-exports it.
 */

import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { reverseJournalEntry } from '../gl/journalEntryService';
import type { SupplierInvoice } from '../../types/ap.types';
import type { PostingActorOpts } from '../gl/journalEntryMeta';
import { releaseCapturedDocumentPostingClaim } from '../capture/capturePostingClaimRelease';
import { planSupplierInvoiceCancel, SupplierInvoiceCancelRefusal } from './supplierInvoiceCancelPlan';
import { lockStandingChainHead } from '../shared/journalChainHead';
import { mapInvoiceRow } from './supplierInvoiceWorkflowRow';
import { RowLockTimeoutError, underFlowLockBudget, withRowLockBudget } from '../core/rowLockBudget';
import { syncGroupRowFor } from '../intercompany/mirrorHooks';
import { guardBillGone, type BillGoneReopen, type HeldPos } from './purchaseOrderBillingClose';

type Row = DbRow;

export async function cancelSupplierInvoice(
  companyId: string,
  id: string,
  userId: string,
  // Optional and last-positional, as on approveSupplierInvoice: an MCP cancel
  // must stamp its reversal as the agent's, or list_agent_postings cannot see it.
  // `heldPos`: the POs closed by billing the caller locked before the bill (the bulk route, the MCP tool): not locked again.
  opts?: PostingActorOpts & { heldPos?: HeldPos },
): Promise<SupplierInvoice & BillGoneReopen> {
  // SAVEPOINT: callers map errors to 400 and withAuth commits on <5xx — a failure after the reversal's draft
  // INSERTs must roll them back (see customerInvoiceCancelService). One lock budget for the flow (D8 round 10).
  return withSavepoint('cancel_supplier_invoice', () => underFlowLockBudget(`Supplier invoice ${id}`, () =>
    cancelSupplierInvoiceInner(companyId, id, userId, opts)));
}

async function cancelSupplierInvoiceInner(
  companyId: string,
  id: string,
  userId: string,
  // `heldPos`: the POs closed by billing the caller locked before the bill (the bulk route, the MCP tool): not locked again.
  opts?: PostingActorOpts & { heldPos?: HeldPos },
): Promise<SupplierInvoice & BillGoneReopen> {
  try {
    // The POs closed BY BILLING this bill ties, locked BEFORE the bill (PO -> bill, as link / unlink): one it leaves under-billed reopens.
    const billing = await guardBillGone(companyId, id, opts?.heldPos);
    // FOR UPDATE: serialise concurrent cancels (both passing the guards would double-reverse the journal).
    // K-053: a soft-deleted bill is not cancellable — same reasoning as
    // customerInvoiceCancelService, where it is spelled out.
    const lockRows = await withRowLockBudget(async () => (await sql`
      SELECT id, status, gl_journal_entry_id FROM supplier_invoices
      WHERE id = ${id} AND company_id = ${companyId}::UUID
        AND deleted_at IS NULL
      FOR UPDATE
    `) as Row[], () => new RowLockTimeoutError(`Supplier invoice ${id}`)); // bounded (D8 round 9)
    if (lockRows.length === 0) throw new Error(`Supplier invoice ${id} not found`);
    const locked = lockRows[0]!;
    const status = String(locked.status);
    if (status === 'paid' || status === 'partially_paid') {
      throw new Error('Cannot cancel invoice with payments');
    }
    if (status === 'cancelled') {
      throw new Error('Supplier invoice is already cancelled');
    }
    // Every refusal the MCP tool's plan makes, on the row just locked, before
    // any write — the UI Cancel button and the bulk action reach only this.
    await planSupplierInvoiceCancel(companyId, id);
    await billing.recheck(); // the bill is locked: a PO a link closed by billing meanwhile (Codex gate)

    // P1.1 (audit C1, systemic): approve posts GL — cancel must reverse it.
    // Reverse BEFORE the flip so a blocked reversal (locked period) aborts
    // the cancel. The approval journal's chain HEAD while the chain stands (D8),
    // decided under the head LOCK, not from the plan's unlocked walk (round 6):
    // a reversal landing between the two would otherwise be acted on stale.
    if (locked.gl_journal_entry_id) {
      const head = await lockStandingChainHead(companyId, String(locked.gl_journal_entry_id),
        (m) => new SupplierInvoiceCancelRefusal(m));
      if (head) await reverseJournalEntry(companyId, head, userId, opts);
    }

    // Null the journal link (mirrors customerInvoiceCancelService): a future
    // legitimate re-post must create a fresh journal, not reuse the reversed pair.
    const rows = (await sql`
      UPDATE supplier_invoices SET status = 'cancelled', gl_journal_entry_id = NULL
      WHERE id = ${id} AND company_id = ${companyId}::UUID AND status != 'cancelled'
      RETURNING *
    `) as Row[];
    if (rows.length !== 1) {
      throw new Error('Supplier invoice state changed concurrently — cancel aborted');
    }

    // The other half of the capture posting claim's undo. A cancelled invoice
    // is not a live claim on the receipt behind it, and until this line the
    // document stayed refused by every posting route with no way back — which
    // is what made "Reverse the journal or invoice first" a dead end.
    const cancelledSourceDoc = rows[0]!.source_document_id;
    if (cancelledSourceDoc) {
      await releaseCapturedDocumentPostingClaim(companyId, String(cancelledSourceDoc));
    }

    // Intercompany P2: a cancelled bill is no longer approved: the sender's group row goes back to unmatched.
    await syncGroupRowFor(companyId, 'supplier_invoice', id);

    const reopen = await billing.reopen({ userId, via: 'cancel_supplier_invoice', why: `bill ${String(rows[0]!.invoice_number ?? id)} cancelled` });
    return { ...mapInvoiceRow(rows[0]!), ...reopen };
  } catch (err) {
    log.error('Failed to cancel supplier invoice', { id, error: err }, 'accounting');
    throw err;
  }
}
