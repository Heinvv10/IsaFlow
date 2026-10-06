/**
 * Credit-note APPROVAL — the posting path.
 *
 * Split from creditNoteService.ts for the 300-line cap in CLAUDE.md; the
 * division is by direction, not convenience. Everything here moves the ledger
 * and takes the row lock first. creditNoteService re-exports it, so
 * `@/modules/accounting/services/ar/creditNoteService` remains the single
 * import surface every caller and test mock already uses.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry, reverseJournalEntry } from '../gl/journalEntryService';
import { getSystemAccount } from '../gl/systemAccountResolver';
import type { CreditNote } from '../../types/ar.types';
import type { JournalLineInput } from '../../types/gl.types';
import { lockCreditNoteForUpdate } from './creditNoteLock';
import { mapRow } from './creditNoteMapper';
import { actorMeta, type PostingActorOpts } from '../gl/journalEntryMeta';
import {
  applyCreditNote,
  deriveCreditNoteStatus,
  type CreditNoteAutoApply,
} from '../shared/creditNoteFifo';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { assertApprovalCleared } from '../gl/approvalGate';
import { creditNoteApprovalType } from '../gl/approvalDocumentTypes';

/**
 * `autoApply` defaults to 'fifo': a credit note exists to reduce what the
 * counterparty owes or is owed, and leaving it on account by default is what
 * left credit sitting unconsumed while the same entity's oldest documents aged.
 * 'none' keeps the pre-FIFO behaviour — the linked document only.
 */
export type ApproveCreditNoteOpts = PostingActorOpts & { autoApply?: CreditNoteAutoApply };

export async function approveCreditNote(
  companyId: string,
  id: string,
  userId: string,
  // Optional and last-positional so every existing caller keeps human
  // attribution. Without it createJournalEntry falls back to
  // defaultHumanMeta(userId) and an MCP-approved credit note posts labelled
  // `human:<userId>` — claiming the token owner did it by hand, and invisible
  // to list_agent_postings, which filters posting_agent LIKE 'mcp:%'.
  opts?: ApproveCreditNoteOpts,
): Promise<CreditNote> {
  await assertNotImpersonating(); // R-032 L5: first, before any read or write
  try {
    // FOR UPDATE, not a plain SELECT: the status check below and the posting
    // that follows are a check-then-act pair. Two concurrent approvals of the
    // same draft both read 'draft' and both post a journal — reproduced against
    // a real database — and a linked note also bumps the invoice's amount_paid
    // on each pass, double-crediting the receivable. The lock holds for the rest
    // of the request, so the second caller re-reads the settled status and
    // refuses here instead.
    const cn = await lockCreditNoteForUpdate(companyId, id);
    if (!cn) throw new Error(`Credit note ${id} not found`);
    if (String(cn.status) !== 'draft') throw new Error(`Cannot approve credit note with status: ${cn.status}`);
    // R-035 PR3: under the lock and before any other read or write, so a
    // refusal (ApprovalRequiredError, answered 409) has written nothing.
    await assertApprovalCleared(companyId, creditNoteApprovalType(String(cn.type)), id);

    let lines: JournalLineInput[];

    if (String(cn.type) === 'customer') {
      // Customer CN: DR Revenue, CR Accounts Receivable
      const revenueAccount = await getSystemAccount('default_revenue', companyId);
      const arAccount = await getSystemAccount('receivable', companyId);
      const vatAccount = await getSystemAccount('vat_output', companyId);

      lines = [
        { glAccountId: revenueAccount.id, debit: Number(cn.subtotal), credit: 0,
          description: `Credit note ${cn.credit_note_number}` },
      ];
      if (Number(cn.tax_amount) > 0 && vatAccount) {
        // Coded 'standard' (2026-09-25): an uncoded VAT leg is a pre-filing
        // exception, and 'standard' is what the VAT201 already read it as.
        lines.push({ glAccountId: vatAccount.id, debit: Number(cn.tax_amount), credit: 0,
          description: `VAT reversal: ${cn.credit_note_number}`, vatType: 'standard' });
      }
      lines.push({ glAccountId: arAccount.id, debit: 0, credit: Number(cn.total_amount),
        description: `AR credit: ${cn.credit_note_number}` });
    } else {
      // Supplier CN: DR Accounts Payable, CR Expense
      const apAccount = await getSystemAccount('payable', companyId);
      const expenseAccount = await getSystemAccount('default_expense', companyId);
      const vatAccount = await getSystemAccount('vat_input', companyId);

      lines = [
        { glAccountId: apAccount.id, debit: Number(cn.total_amount), credit: 0,
          description: `AP credit: ${cn.credit_note_number}` },
      ];
      if (Number(cn.tax_amount) > 0 && vatAccount) {
        lines.push({ glAccountId: vatAccount.id, debit: 0, credit: Number(cn.tax_amount),
          description: `VAT reversal: ${cn.credit_note_number}`, vatType: 'standard' });
      }
      lines.push({ glAccountId: expenseAccount.id, debit: 0, credit: Number(cn.subtotal),
        description: `Expense credit: ${cn.credit_note_number}` });
    }

    // credit_date comes back from pg as a Date object (or a string on some
    // paths); String(Date) yields "Fri Jul 04 2026 ... GMT+0200 (...)" which
    // Postgres rejects as an invalid time zone when inserted into entry_date.
    // fmtDate (not toISODate) is required here: node-postgres constructs DATE
    // columns at LOCAL midnight, so toISODate's UTC-based slicing rolls the
    // date back a day on this server's UTC+2 timezone — fmtDate reads the
    // same local getters pg used to build the Date, and also handles the
    // string shape (already 'YYYY-MM-DD' or an ISO timestamp).
    const entryDate = fmtDate(cn.credit_date);
    if (!entryDate) throw new Error(`Credit note ${id} has an invalid credit_date value`);

    // No sourceDocumentId: gl_journal_entries.source_document_id has an FK to
    // captured_documents(id) only (migration 409); a credit note's own id
    // would violate it. The credit_note <-> journal entry link is instead
    // persisted below via credit_notes.gl_journal_entry_id.
    const je = await createJournalEntry(companyId, {
      entryDate,
      description: `Credit note ${cn.credit_note_number}`,
      source: 'auto_credit_note',
      lines,
    }, userId, actorMeta(opts));
    await postJournalEntry(companyId, je.id, userId);

    // N6 (P2.1) and L2: approving a note APPLIES it. A linked note settles the
    // document it names first, capped at that document's outstanding balance,
    // and the REMAINDER then walks the same entity's other open documents
    // oldest first. The arithmetic, the allocation rows and the status
    // recompute all live in shared/creditNoteFifo — read its header before
    // changing any of this.
    //
    // Capping rather than refusing when a document is already settled is
    // deliberate: a credit note against a paid invoice is an ordinary event (a
    // return after payment). What CHANGED with the FIFO walk is where the
    // excess goes — it used to be stranded on a note at 'applied' that could
    // never be applied again; it now settles the next open document, and
    // whatever is still left is on-account credit the aged reports net.
    const side = String(cn.type) === 'customer' ? 'customer' as const : 'supplier' as const;
    const application = await applyCreditNote({
      companyId,
      creditNoteId: id,
      side,
      entityId: side === 'customer'
        ? (cn.client_id ? String(cn.client_id) : null)
        : (cn.supplier_id ? String(cn.supplier_id) : null),
      totalAmount: Number(cn.total_amount),
      linkedInvoiceId: side === 'customer'
        ? (cn.customer_invoice_id ? String(cn.customer_invoice_id) : null)
        : (cn.supplier_invoice_id ? String(cn.supplier_invoice_id) : null),
      autoApply: opts?.autoApply ?? 'fifo',
    });
    const appliedAmount = application.appliedAmount;

    // DERIVED from what was consumed, never chosen: 'partially_applied' is the
    // state a note spread across some but not all of its face value is in, and
    // it is the state every statement and ledger reader now distinguishes.
    const finalStatus = deriveCreditNoteStatus(appliedAmount, Number(cn.total_amount));
    const updatedRows = (await sql`
      UPDATE credit_notes SET status = ${finalStatus}, approved_by = ${userId}::UUID,
        approved_at = NOW(), gl_journal_entry_id = ${je.id}::UUID,
        applied_amount = ${appliedAmount}
      WHERE id = ${id} AND company_id = ${companyId}::UUID AND status = 'draft'
      RETURNING *
    `) as Record<string, unknown>[];
    // The `status = 'draft'` predicate is a second fence behind the row lock
    // above, not a substitute for it: the lock is what stops two approvals
    // building a journal in parallel, but if a future caller ever reaches this
    // UPDATE without holding it, refusing here beats stamping a second journal
    // onto an already-approved note.
    if (updatedRows.length === 0) {
      throw new Error(`Credit note ${id} was approved concurrently; this attempt posted nothing new.`);
    }
    const updated = updatedRows[0] as Record<string, unknown>;

    log.info('Approved credit note', {
      id, journalEntryId: je.id, status: finalStatus,
      appliedAmount, lines: application.lines.length, remainder: application.remainder,
    }, 'accounting');
    return mapRow(updated);
  } catch (err) {
    log.error('Failed to approve credit note', { id, error: err }, 'accounting');
    throw err;
  }
}

