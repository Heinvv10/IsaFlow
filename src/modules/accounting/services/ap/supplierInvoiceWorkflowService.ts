/**
 * Supplier Invoice Workflow Service
 * Approval, GL posting, payment allocation, status transitions, 3-way match.
 * Extracted from supplierInvoiceService.ts for file-size compliance.
 */

import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry, reverseJournalEntry } from '../gl/journalEntryService';
import { getSystemAccount } from '../gl/systemAccountResolver';
import { validateThreeWayMatch } from '../../utils/threeWayMatch';
import { getSupplierInvoiceById } from './supplierInvoiceService';
import { lockSupplierInvoiceForUpdate } from './supplierInvoiceLock';
import type { SupplierInvoice } from '../../types/ap.types';
import type { JournalLineInput } from '../../types/gl.types';
import { actorMeta, type PostingActorOpts } from '../gl/journalEntryMeta';
import { releaseCapturedDocumentPostingClaim } from '../capture/capturePostingClaimRelease';
import { buildExpenseLines } from './supplierInvoiceExpenseLines';
import { assertBillApprovable, assertBillPostable } from './billPostingGuard';
import { planSupplierInvoiceCancel, SupplierInvoiceCancelRefusal } from './supplierInvoiceCancelPlan';
import { lockStandingChainHead } from '../shared/journalChainHead';
import { documentInPopulation } from '../shared/documentPopulation';
import type { LateClaimInfo, PostJournalOpts } from '../gl/vatLateClaimPlan';
import { claimEvidencedProvisional, settleClaimedProvisional } from './provisionalInvoiceSettlement';
import { mapInvoiceRow } from './supplierInvoiceWorkflowRow';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { RowLockTimeoutError, underFlowLockBudget, withRowLockBudget } from '../core/rowLockBudget';

type Row = DbRow;

export async function approveSupplierInvoice(
  companyId: string,
  id: string,
  userId: string,
  // Optional and last-positional so every existing caller keeps human
  // attribution. Without it, createJournalEntry falls back to
  // defaultHumanMeta(userId) and an MCP-approved invoice posts labelled
  // `human:<userId>` — affirmatively claiming the token owner did it by hand,
  // and invisible to list_agent_postings, which filters posting_agent LIKE
  // 'mcp:%'. That review surface is the control the whole agent-write model
  // rests on. `allowLateInputClaim`: human-initiated callers only (gl/vatLateClaimPlan.ts).
  opts?: PostingActorOpts & PostJournalOpts,
): Promise<SupplierInvoice & { lateClaim?: LateClaimInfo }> {
  await assertNotImpersonating(); // R-032 L5: first, before any read or write
  // All-or-nothing (R-127): the provisional settlement runs AFTER the journal and
  // the status UPDATE, and every route answers a throw 4xx, which withAuth COMMITs.
  return withSavepoint('approve_supplier_invoice', () => approveInner(companyId, id, userId, opts));
}

async function approveInner(
  companyId: string, id: string, userId: string, opts?: PostingActorOpts & PostJournalOpts,
): Promise<SupplierInvoice & { lateClaim?: LateClaimInfo }> {
  try {
    // Serialise concurrent approvals of the SAME invoice before reading its
    // status. Without this the check-then-act window below is wide open: two
    // callers both read 'draft', both post an Expense/VAT/AP journal, and the
    // second UPDATE overwrites the first's gl_journal_entry_id — one bill, two
    // journals, the payable credited twice, and one journal orphaned where no
    // reversal can reach it. cancelSupplierInvoiceInner has locked for this
    // reason since the C1 audit; approve was the remaining asymmetry.
    //
    // Taken BEFORE the read, not instead of it: the lock returns the bare row,
    // while buildExpenseLines needs the invoice's items. Once the lock is held
    // the read below sees the settled state — a caller that was blocked here
    // re-reads 'approved' and refuses on the next line.
    if (!(await lockSupplierInvoiceForUpdate(companyId, id))) {
      throw new Error(`Supplier invoice ${id} not found`);
    }
    const invoice = await getSupplierInvoiceById(companyId, id);
    if (!invoice) throw new Error(`Supplier invoice ${id} not found`);
    if (invoice.status !== 'draft' && invoice.status !== 'pending_approval') {
      throw new Error(`Cannot approve invoice with status: ${invoice.status}`);
    }
    await assertBillApprovable(companyId, id); // R-035 + FX PR0: under the lock, before any write

    // A DRAFT can already carry a journal, and posting a second one is the
    // worst outcome this function has.
    //
    // `postSupplierInvoiceToGL` posts the Expense/VAT/AP journal and sets
    // `gl_journal_entry_id` WITHOUT touching `status` — and it is exposed to
    // operators as the "Post to GL" bulk action
    // (pages/api/accounting/supplier-invoices-bulk-action.ts), which accepts
    // drafts. So "post 40 drafts to GL, then approve them" leaves 40 bills with
    // a journal and status still 'draft'. Guarding on status alone, this
    // function would build and post a SECOND journal for each — AP credited
    // twice, expenses and input VAT doubled — and then overwrite
    // `gl_journal_entry_id` with the new id, stranding the first journal where
    // `cancelSupplierInvoiceInner` (which reverses only the id on the row) can
    // never reach it. No race is required; the two calls are sequential.
    //
    // The AR twin has always been immune: `postCustomerInvoiceToGL` early-returns
    // on `if (inv.gl_journal_entry_id)`. This is that guard, on the AP side.
    //
    // The existing journal is REUSED rather than refused: the document is
    // genuinely unapproved, and the lines this function would build are the
    // ones already posted, so the correct completion of "approve" is to flip the
    // status and keep the journal that is already in the ledger.
    if (invoice.glJournalEntryId) {
      const reused = (await sql`
        UPDATE supplier_invoices
        SET status = 'approved', approved_by = ${userId}::UUID, approved_at = NOW()
        WHERE id = ${id} AND company_id = ${companyId}::UUID
        RETURNING *
      `) as Row[];
      log.info('Approved supplier invoice that already carried a journal', {
        id, journalEntryId: invoice.glJournalEntryId,
      }, 'accounting');
      return mapInvoiceRow(reused[0]!);
    }

    const provisional = await claimEvidencedProvisional(companyId, id); // R-127: locked before the first write

    // Auto-post GL entry: DR Expense + DR VAT Input, CR Accounts Payable
    const apAccount = await getSystemAccount('payable', companyId);
    const vatAccount = await getSystemAccount('vat_input', companyId);
    const defaultExpenseAccount = await getSystemAccount('default_expense', companyId);

    await assertBillPostable(companyId, invoice);
    const lines: JournalLineInput[] = buildExpenseLines(invoice, defaultExpenseAccount.id);

    if (invoice.taxAmount > 0) {
      lines.push({
        glAccountId: vatAccount.id,
        debit: invoice.taxAmount,
        credit: 0,
        description: `VAT on ${invoice.invoiceNumber}`,
        vatType: 'standard',
      });
    }

    lines.push({
      glAccountId: apAccount.id,
      debit: 0,
      credit: invoice.totalAmount,
      description: `AP: ${invoice.invoiceNumber}`,
    });

    // sourceDocumentId FKs to captured_documents(id) — not supplier_invoices.
    // The invoice↔JE link is maintained via supplier_invoices.gl_journal_entry_id
    // below.
    const journalEntry = await createJournalEntry(companyId, {
      entryDate: invoice.invoiceDate,
      description: `Supplier invoice ${invoice.invoiceNumber}`,
      source: 'auto_supplier_invoice',
      lines,
    }, userId, actorMeta(opts), { allowLateInputClaim: opts?.allowLateInputClaim });

    const posted = await postJournalEntry(companyId, journalEntry.id, userId, opts);

    const updated = (await sql`
      UPDATE supplier_invoices
      SET status = 'approved', approved_by = ${userId}::UUID, approved_at = NOW(),
          gl_journal_entry_id = ${journalEntry.id}::UUID
      WHERE id = ${id} AND company_id = ${companyId}::UUID
      RETURNING *
    `) as Row[];
    const settled = await settleClaimedProvisional(companyId, provisional, invoice, apAccount.id, userId, opts);

    log.info('Approved supplier invoice', { id, journalEntryId: journalEntry.id }, 'accounting');
    return { ...mapInvoiceRow(settled ?? updated[0]!), ...(posted.lateClaim ? { lateClaim: posted.lateClaim } : {}) };
  } catch (err) {
    log.error('Failed to approve supplier invoice', { id, error: err }, 'accounting');
    throw err;
  }
}

/**
 * Idempotent GL backfill for already-approved supplier invoices.
 * Equivalent of approveSupplierInvoice but skips the status guard.
 */
export async function postSupplierInvoiceToGL(
  companyId: string,
  id: string,
  userId: string,
  opts?: PostingActorOpts,
): Promise<{ journalEntryId: string; alreadyPosted: boolean }> {
  await assertNotImpersonating(); // R-032 L5: first, before any read or write
  // All-or-nothing, as approveSupplierInvoice (R-127).
  return withSavepoint('post_supplier_invoice_gl', () => postToGLInner(companyId, id, userId, opts));
}

async function postToGLInner(
  companyId: string, id: string, userId: string, opts?: PostingActorOpts,
): Promise<{ journalEntryId: string; alreadyPosted: boolean }> {
  // Same check-then-act window approveSupplierInvoice closes at :95, and the
  // same reason: this function decides on `glJournalEntryId` below and then
  // overwrites it. Unlocked, two overlapping "Post to GL" calls both read NULL,
  // both post an Expense/VAT/AP journal, and the second UPDATE strands the
  // first where cancelSupplierInvoiceInner (which reverses only the id on the
  // row) can never reach it — AP credited twice for one bill. The bulk action
  // (supplier-invoices-bulk-action.ts, action=post_gl) walks up to the route's
  // 200-id cap in one transaction, so the window is seconds. Each id there is
  // wrapped in its own savepoint, so this lock timing out is that id's failure
  // and not the batch's. Locking only in approve left this path free to race an
  // approve that WAS holding the row lock.
  //
  // Taken BEFORE the read so the guards below see settled state: a caller that
  // blocked here re-reads the journal id the winner wrote and early-returns
  // alreadyPosted.
  if (!(await lockSupplierInvoiceForUpdate(companyId, id))) {
    throw new Error(`Supplier invoice ${id} not found`);
  }
  const invoice = await getSupplierInvoiceById(companyId, id);
  if (!invoice) throw new Error(`Supplier invoice ${id} not found`);

  // Cancel NULLs gl_journal_entry_id after reversing the journal — without
  // this status guard the backfill would re-post a fresh Expense/VAT/AP
  // journal for a cancelled document (the inverse of audit C1).
  if (invoice.status === 'cancelled') {
    throw new Error('Cannot post a cancelled supplier invoice to GL');
  }

  if (invoice.glJournalEntryId) {
    return { journalEntryId: invoice.glJournalEntryId, alreadyPosted: true };
  }

  // R-118: BELOW the early return on purpose — a bill that already carries a
  // journal posts nothing here whatever its status, and refusing it would turn
  // an idempotent no-op into an error for rows written before this guard.
  // What is refused is posting a NEW journal outside the AP population: a
  // draft's journal stands on the GL half of every AP-vs-GL reconciliation
  // while documentInPopulationExpr keeps the document off the other half — a
  // permanent difference by the bill's full amount, in one click, because the
  // bulk "Post to GL" action offers itself on any selection. Approving is what
  // posts a draft: approveSupplierInvoice moves the status and posts together.
  if (!documentInPopulation(invoice.status)) {
    throw new Error(
      `Cannot post a ${invoice.status} supplier invoice to GL — approve it instead, `
      + 'which posts the journal and moves the status together.',
    );
  }

  const provisional = await claimEvidencedProvisional(companyId, id); // R-127, as in approve
  const apAccount = await getSystemAccount('payable', companyId);
  const vatAccount = await getSystemAccount('vat_input', companyId);
  const defaultExpenseAccount = await getSystemAccount('default_expense', companyId);

  await assertBillPostable(companyId, invoice);
  const lines: JournalLineInput[] = buildExpenseLines(invoice, defaultExpenseAccount.id);

  if (invoice.taxAmount > 0) {
    lines.push({
      glAccountId: vatAccount.id,
      debit: invoice.taxAmount,
      credit: 0,
      description: `VAT on ${invoice.invoiceNumber}`,
      vatType: 'standard',
    });
  }

  lines.push({
    glAccountId: apAccount.id,
    debit: 0,
    credit: invoice.totalAmount,
    description: `AP: ${invoice.invoiceNumber}`,
  });

  const journalEntry = await createJournalEntry(companyId, {
    entryDate: invoice.invoiceDate,
    description: `Supplier invoice ${invoice.invoiceNumber}`,
    source: 'auto_supplier_invoice',
    lines,
  }, userId, actorMeta(opts));

  // NEVER a late claim: this posts a bill that is ALREADY approved, so it was in
  // the figures of the VAT period its date falls in when that return was filed.
  // Only an approval made in the same act may claim late (approveSupplierInvoice).
  await postJournalEntry(companyId, journalEntry.id, userId);

  await sql`
    UPDATE supplier_invoices
    SET gl_journal_entry_id = ${journalEntry.id}::UUID
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `;
  await settleClaimedProvisional(companyId, provisional, invoice, apAccount.id, userId, opts);

  log.info('Backfilled supplier invoice GL', { id, journalEntryId: journalEntry.id }, 'accounting');
  return { journalEntryId: journalEntry.id, alreadyPosted: false };
}

export async function cancelSupplierInvoice(
  companyId: string,
  id: string,
  userId: string,
  // Optional and last-positional, as on approveSupplierInvoice: an MCP cancel
  // must stamp its reversal as the agent's, or list_agent_postings cannot see it.
  opts?: PostingActorOpts,
): Promise<SupplierInvoice> {
  // SAVEPOINT: callers map errors to 400 and withAuth commits on <5xx — a failure after the reversal's draft
  // INSERTs must roll them back (see customerInvoiceCancelService). One lock budget for the flow (D8 round 10).
  return withSavepoint('cancel_supplier_invoice', () => underFlowLockBudget(`Supplier invoice ${id}`, () =>
    cancelSupplierInvoiceInner(companyId, id, userId, opts)));
}

async function cancelSupplierInvoiceInner(
  companyId: string,
  id: string,
  userId: string,
  opts?: PostingActorOpts,
): Promise<SupplierInvoice> {
  try {
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

    return mapInvoiceRow(rows[0]!);
  } catch (err) {
    log.error('Failed to cancel supplier invoice', { id, error: err }, 'accounting');
    throw err;
  }
}

const DEFAULT_TOLERANCE_PERCENT = 2;

export interface ThreeWayMatchItemResult {
  itemId: string;
  itemDescription: string;
  lineMatchStatus: 'unmatched' | 'po_matched' | 'grn_matched' | 'fully_matched';
  qtyVariancePct: number;
  priceVariancePct: number;
  match: ReturnType<typeof validateThreeWayMatch>;
}

export async function performThreeWayMatch(
  companyId: string,
  invoiceId: string,
): Promise<{
  invoiceId: string;
  matchStatus: 'unmatched' | 'po_matched' | 'grn_matched' | 'fully_matched';
  itemResults: ThreeWayMatchItemResult[];
}> {
  const invoice = await getSupplierInvoiceById(companyId, invoiceId);
  if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);

  if (!invoice.purchaseOrderId) {
    log.info('performThreeWayMatch: invoice has no linked PO — returning unmatched', { invoiceId }, 'accounting');
    return { invoiceId, matchStatus: 'unmatched', itemResults: [] };
  }

  // Load tolerance from supplier_coding_rules; fall back to 2%
  const ruleRows = (await sql`
    SELECT qty_tolerance_pct, price_tolerance_pct
    FROM supplier_coding_rules
    WHERE company_id = ${companyId}::UUID AND supplier_id = ${invoice.supplierId}::UUID
    LIMIT 1
  `) as Row[];
  const qtyTolerance = ruleRows.length > 0 && ruleRows[0]!.qty_tolerance_pct != null
    ? Number(ruleRows[0]!.qty_tolerance_pct) : DEFAULT_TOLERANCE_PERCENT;
  const priceTolerance = ruleRows.length > 0 && ruleRows[0]!.price_tolerance_pct != null
    ? Number(ruleRows[0]!.price_tolerance_pct) : DEFAULT_TOLERANCE_PERCENT;

  const poItems = (await sql`
    SELECT * FROM po_items
    WHERE purchase_order_id = ${invoice.purchaseOrderId}::UUID AND company_id = ${companyId}::UUID
  `) as Row[];

  const grnItems = invoice.grnId
    ? ((await sql`
        SELECT * FROM grn_items
        WHERE grn_id = ${invoice.grnId}::UUID AND company_id = ${companyId}::UUID
      `) as Row[])
    : [];

  const itemResults: ThreeWayMatchItemResult[] = [];

  for (const item of (invoice.items ?? [])) {
    const poItem = item.poItemId ? poItems.find((p: Row) => String(p.id) === item.poItemId) : null;
    const grnItem = poItem
      ? grnItems.find((g: Row) => String(g.po_item_id) === String(poItem.id))
      : null;

    const poQty = poItem ? Number(poItem.quantity) : 0;
    const poPrice = poItem ? Number(poItem.unit_price) : 0;
    const grnQtyReceived = grnItem ? Number(grnItem.quantity_received) : 0;

    const qtyVariancePct = (item.quantity - poQty) / Math.max(poQty, 1) * 100;
    const priceVariancePct = (item.unitPrice - poPrice) / Math.max(poPrice, 1) * 100;

    const match = validateThreeWayMatch({
      poQuantity: poQty,
      poUnitPrice: poPrice,
      grnQuantityReceived: grnQtyReceived,
      invoiceQuantity: item.quantity,
      invoiceUnitPrice: item.unitPrice,
      qtyTolerancePercent: qtyTolerance,
      priceTolerancePercent: priceTolerance,
    });

    const lineMatchStatus = match.status;

    // Persist per-line match state — log failures but keep processing other lines
    try {
      // supplier_invoice_items has no company_id; scope via parent invoice
      await sql`
        UPDATE supplier_invoice_items sii
        SET line_match_status = ${lineMatchStatus},
            qty_variance_pct   = ${qtyVariancePct},
            price_variance_pct = ${priceVariancePct},
            match_computed_at  = NOW()
        FROM supplier_invoices si
        WHERE sii.id = ${item.id}::UUID
          AND si.id = sii.supplier_invoice_id
          AND si.company_id = ${companyId}::UUID
      `;
    } catch (updateErr) {
      log.error('Failed to persist line match status', { itemId: item.id, error: updateErr }, 'accounting');
    }

    itemResults.push({
      itemId: item.id,
      itemDescription: item.description,
      lineMatchStatus,
      qtyVariancePct,
      priceVariancePct,
      match,
    });
  }

  const overallStatus = itemResults.length === 0
    ? 'unmatched'
    : itemResults.every(r => r.lineMatchStatus === 'fully_matched')
      ? 'fully_matched'
      : itemResults.some(r => r.lineMatchStatus === 'po_matched')
        ? 'po_matched'
        : itemResults.some(r => r.lineMatchStatus === 'grn_matched')
          ? 'grn_matched'
          : 'unmatched';

  await sql`
    UPDATE supplier_invoices SET match_status = ${overallStatus}
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
  `;

  log.info('3-way match completed', { invoiceId, matchStatus: overallStatus, lineCount: itemResults.length }, 'accounting');
  return { invoiceId, matchStatus: overallStatus, itemResults };
}

import type { VatType } from '../../types/gl.types';
import type { SupplierInvoiceItem } from '../../types/ap.types';

export type { SupplierInvoiceItem, VatType };
