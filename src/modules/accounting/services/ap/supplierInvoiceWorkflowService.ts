/**
 * Supplier Invoice Workflow Service
 * Approval, GL posting, payment allocation, status transitions, 3-way match.
 * Extracted from supplierInvoiceService.ts for file-size compliance.
 */

import { syncGroupRowFor } from '../intercompany/mirrorHooks';
import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from '../gl/journalEntryService';
import { getSystemAccount } from '../gl/systemAccountResolver';
import { getSupplierInvoiceById } from './supplierInvoiceService';
import type { SupplierInvoice } from '../../types/ap.types';
import type { JournalLineInput } from '../../types/gl.types';
import { actorMeta, type PostingActorOpts } from '../gl/journalEntryMeta';
import { buildExpenseLines } from './supplierInvoiceExpenseLines';
import { assertBillApprovable, assertBillPostable } from './billPostingGuard';
import { POST_AS_STORED, assertPostsStoredDimensions } from '../gl/dimensions/dimensionStoredPosting';
import { placeCostCentres } from '../gl/dimensions/costCentrePick'; // the legacy pick, in its slot, with its FNO
import { documentInPopulation } from '../shared/documentPopulation';
import type { LateClaimInfo, PostJournalOpts } from '../gl/vatLateClaimPlan';
import { claimEvidencedProvisional, settleClaimedProvisional } from './provisionalInvoiceSettlement';
import { mapInvoiceRow } from './supplierInvoiceWorkflowRow';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { budgetWarningsOf, checkBillBudget, lockBillAfterBudgetGate, logApproveFailure, placeCheckedBillLines, type BillBudgetOpts, type BudgetWarned } from './supplierInvoiceBudgetCheck';

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
  opts?: PostingActorOpts & PostJournalOpts & BillBudgetOpts,
): Promise<SupplierInvoice & { lateClaim?: LateClaimInfo; warnings?: string[] } & BudgetWarned> {
  await assertNotImpersonating(); // R-032 L5: first, before any read or write
  // All-or-nothing (R-127): the provisional settlement runs AFTER the journal and
  // the status UPDATE, and every route answers a throw 4xx, which withAuth COMMITs.
  return withSavepoint('approve_supplier_invoice', () => approveInner(companyId, id, userId, opts));
}

async function approveInner(
  companyId: string, id: string, userId: string, opts?: PostingActorOpts & PostJournalOpts & BillBudgetOpts,
): Promise<SupplierInvoice & { lateClaim?: LateClaimInfo; warnings?: string[] } & BudgetWarned> {
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
    const budgetGate = await lockBillAfterBudgetGate(companyId, id, opts?.budget); // P5-2: the budget lock (block) FIRST, then this row
    if (!budgetGate) throw new Error(`Supplier invoice ${id} not found`);
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
        SET status = 'approved', approved_by = ${userId}, approved_at = NOW()
        WHERE id = ${id} AND company_id = ${companyId}::UUID
        RETURNING *
      `) as Row[];
      log.info('Approved supplier invoice that already carried a journal', {
        id, journalEntryId: invoice.glJournalEntryId,
      }, 'accounting');
      // Intercompany P2: this bill is approved too (the journal was posted earlier): the sender's group row follows it.
      await syncGroupRowFor(companyId, 'supplier_invoice', id);
      return mapInvoiceRow(reused[0]!);
    }

    const provisional = await claimEvidencedProvisional(companyId, id, userId); // R-127: locked before the first write

    // Auto-post GL entry: DR Expense + DR VAT Input, CR Accounts Payable
    const apAccount = await getSystemAccount('payable', companyId);
    const vatAccount = await getSystemAccount('vat_input', companyId);
    const defaultExpenseAccount = await getSystemAccount('default_expense', companyId);

    await assertBillPostable(companyId, invoice);
    const { lines, warnings } = await placeCostCentres(companyId, buildExpenseLines(invoice, defaultExpenseAccount.id), { storedPosting: true });
    // What the pick added follows the stored items' rule: approving refuses an inactive CC1 / CC2 (an inactive FNO too); Post to GL copies.
    await assertPostsStoredDimensions(companyId, invoice.status, lines, (i) => `Supplier invoice ${invoice.invoiceNumber} line ${i + 1}`);
    const budget = await checkBillBudget(companyId, invoice, lines, budgetGate, opts?.budget, userId, provisional); // P5-2: before the first write
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
    }, userId, actorMeta(opts), { allowLateInputClaim: opts?.allowLateInputClaim, ...POST_AS_STORED });

    const posted = await postJournalEntry(companyId, journalEntry.id, userId, opts);

    const updated = (await sql`
      UPDATE supplier_invoices
      SET status = 'approved', approved_by = ${userId}, approved_at = NOW(),
          gl_journal_entry_id = ${journalEntry.id}::UUID
      WHERE id = ${id} AND company_id = ${companyId}::UUID
      RETURNING *
    `) as Row[];
    const settled = await settleClaimedProvisional(companyId, provisional, invoice, apAccount.id, userId, opts);

    // Intercompany P2: a bill an accepted message created is now APPROVED: the sender's group row matches (never at accept).
    await syncGroupRowFor(companyId, 'supplier_invoice', id);

    log.info('Approved supplier invoice', { id, journalEntryId: journalEntry.id }, 'accounting');
    return { ...mapInvoiceRow(settled ?? updated[0]!), ...(posted.lateClaim ? { lateClaim: posted.lateClaim } : {}), ...(warnings.length > 0 ? { warnings } : {}), ...budgetWarningsOf(budget) };
  } catch (err) {
    logApproveFailure(id, err); // a budget refusal at info without its figures (P5-2 S3); every other failure an error
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
  opts?: PostingActorOpts & BillBudgetOpts,
): Promise<{ journalEntryId: string; alreadyPosted: boolean; warnings?: string[] } & BudgetWarned> {
  await assertNotImpersonating(); // R-032 L5: first, before any read or write
  // All-or-nothing, as approveSupplierInvoice (R-127).
  return withSavepoint('post_supplier_invoice_gl', () => postToGLInner(companyId, id, userId, opts));
}

async function postToGLInner(
  companyId: string, id: string, userId: string, opts?: PostingActorOpts & BillBudgetOpts,
): Promise<{ journalEntryId: string; alreadyPosted: boolean; warnings?: string[] } & BudgetWarned> {
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
  const budgetGate = await lockBillAfterBudgetGate(companyId, id, opts?.budget); // P5-2: the budget lock (block) FIRST, as in approve
  if (!budgetGate) throw new Error(`Supplier invoice ${id} not found`);
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

  const provisional = await claimEvidencedProvisional(companyId, id, userId); // R-127, as in approve
  const apAccount = await getSystemAccount('payable', companyId);
  const vatAccount = await getSystemAccount('vat_input', companyId);
  const defaultExpenseAccount = await getSystemAccount('default_expense', companyId);

  await assertBillPostable(companyId, invoice);
  const { lines, warnings, budget } = await placeCheckedBillLines(companyId, invoice, defaultExpenseAccount.id, budgetGate, opts?.budget, userId, provisional); // P5-2

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
  }, userId, actorMeta(opts), POST_AS_STORED);

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
  return { journalEntryId: journalEntry.id, alreadyPosted: false, ...(warnings.length > 0 ? { warnings } : {}), ...budgetWarningsOf(budget) };
}


export { cancelSupplierInvoice } from './supplierInvoiceCancelFlow';
export { performThreeWayMatch, type ThreeWayMatchItemResult } from './supplierInvoiceThreeWayMatch';

import type { VatType } from '../../types/gl.types';
import type { SupplierInvoiceItem } from '../../types/ap.types';

export type { SupplierInvoiceItem, VatType };
