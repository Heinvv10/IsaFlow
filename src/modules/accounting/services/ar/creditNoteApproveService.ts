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
import { recomputeInvoiceStatus } from './invoiceStatusRecompute';
import { mapRow } from './creditNoteMapper';

export async function approveCreditNote(
  companyId: string,
  id: string,
  userId: string,
  // Optional and last-positional so every existing caller keeps human
  // attribution. Without it createJournalEntry falls back to
  // defaultHumanMeta(userId) and an MCP-approved credit note posts labelled
  // `human:<userId>` — claiming the token owner did it by hand, and invisible
  // to list_agent_postings, which filters posting_agent LIKE 'mcp:%'.
  opts?: { postingAgent?: string },
): Promise<CreditNote> {
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
        lines.push({ glAccountId: vatAccount.id, debit: Number(cn.tax_amount), credit: 0,
          description: `VAT reversal: ${cn.credit_note_number}` });
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
          description: `VAT reversal: ${cn.credit_note_number}` });
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
    }, userId, opts?.postingAgent ? { postingAgent: opts.postingAgent } : undefined);
    await postJournalEntry(companyId, je.id, userId);

    // N6 (P2.1): approving a LINKED note auto-applies it, so it must land in
    // 'applied' — leaving it 'approved' let the separate apply action credit
    // the same invoice a SECOND time (applyCreditNoteToInvoice recomputes
    // outstanding from the already-bumped row and happily double-credits).
    // Auto-apply, CAPPED and VERIFIED.
    //
    // This used to add the note's full total unconditionally and then set
    // autoApplied = true without looking at the row count. Three consequences,
    // all reachable: a note larger than the invoice drove amount_paid past
    // total_amount (a 5,000 note on a 1,000 invoice left a 4,000 phantom
    // overpayment netting against that customer's other real debt in aged
    // debtors); a linked invoice that had since been deleted matched zero rows
    // while the note still landed in 'applied', so approve_credit_note told the
    // agent a receivable had been reduced when nothing was written; and the
    // invoice's status was never recomputed, so an invoice fully covered by a
    // note kept status 'approved' with amount_paid >= total_amount — while
    // cancel DID recompute, making the two non-inverse.
    //
    // Capping rather than refusing when the invoice is already settled is
    // deliberate: a credit note against a paid invoice is an ordinary event (a
    // return after payment), and the excess stays as unallocated credit the
    // note still carries. applied_amount reports exactly what was consumed, so
    // the difference is visible rather than silently lost.
    const applyTarget = String(cn.type) === 'customer'
      ? { table: 'customer' as const, id: cn.customer_invoice_id }
      : { table: 'supplier' as const, id: cn.supplier_invoice_id };

    let appliedAmount = 0;
    if (applyTarget.id) {
      const invRows = (applyTarget.table === 'customer'
        ? await sql`
            SELECT total_amount, amount_paid FROM customer_invoices
            WHERE id = ${applyTarget.id}::UUID AND company_id = ${companyId}::UUID`
        : await sql`
            SELECT total_amount, amount_paid FROM supplier_invoices
            WHERE id = ${applyTarget.id}::UUID AND company_id = ${companyId}::UUID`
      ) as Record<string, unknown>[];

      // The link was validated at create time, so a miss here means the invoice
      // was removed afterwards. Refusing beats reporting an application that
      // never happened.
      if (invRows.length === 0) {
        throw new Error(
          `Credit note ${id} is linked to invoice ${String(applyTarget.id)}, which no longer exists in this company.`,
        );
      }
      const inv = invRows[0]!;
      const outstanding = Math.max(0, Number(inv.total_amount) - Number(inv.amount_paid));
      appliedAmount = Math.round(Math.min(Number(cn.total_amount), outstanding) * 100) / 100;

      if (appliedAmount > 0) {
        const applied = (applyTarget.table === 'customer'
          ? await sql`
              UPDATE customer_invoices SET amount_paid = amount_paid + ${appliedAmount}
              WHERE id = ${applyTarget.id}::UUID AND company_id = ${companyId}::UUID
              RETURNING id`
          : await sql`
              UPDATE supplier_invoices SET amount_paid = amount_paid + ${appliedAmount}
              WHERE id = ${applyTarget.id}::UUID AND company_id = ${companyId}::UUID
              RETURNING id`
        ) as Record<string, unknown>[];
        if (applied.length !== 1) {
          throw new Error(`Credit note ${id}: applying to invoice ${String(applyTarget.id)} wrote no row.`);
        }
        await recomputeInvoiceStatus(companyId, applyTarget.table, String(applyTarget.id));
      }
    }
    const autoApplied = appliedAmount > 0;

    // applied_amount records what was ACTUALLY added above, so cancel reverses
    // the recorded figure instead of re-deriving one. The auto-apply adds the
    // full total with no cap, so that is the amount here.
    const finalStatus = autoApplied ? 'applied' : 'approved';
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

    log.info('Approved credit note', { id, journalEntryId: je.id }, 'accounting');
    return mapRow(updated);
  } catch (err) {
    log.error('Failed to approve credit note', { id, error: err }, 'accounting');
    throw err;
  }
}

