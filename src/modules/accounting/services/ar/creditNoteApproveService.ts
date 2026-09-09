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
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from '../gl/journalEntryService';
import {mutateArRelatedEntity} from './arRelatedEntityEffect';
import {resolveArAccounts} from '../controls/arControlAccounts';
import {registerGeneratedJournal} from '../controls/generatedJournalPermit';
import {requireArControl,runArControlled,type ArApprovalOptions} from './arControlBoundary';
import type {ArParentControl} from './customerInvoiceFinancialEffect';
import type { CreditNote } from '../../types/ar.types';
import type { JournalLineInput } from '../../types/gl.types';
import { lockCreditNoteForUpdate } from './creditNoteLock';
import { recomputeInvoiceStatus } from './invoiceStatusRecompute';
import { mapRow } from './creditNoteMapper';
import { actorMeta, type PostingActorOpts } from '../gl/journalEntryMeta';

async function approveCreditNoteEffect(
  companyId: string,
  id: string,
  userId: string,
  // Optional and last-positional so every existing caller keeps human
  // attribution. Without it createJournalEntry falls back to
  // defaultHumanMeta(userId) and an MCP-approved credit note posts labelled
  // `human:<userId>` — claiming the token owner did it by hand, and invisible
  // to list_agent_postings, which filters posting_agent LIKE 'mcp:%'.
  opts: PostingActorOpts | undefined,
  parentControl: ArParentControl,
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

    const ctx=requireArControl(companyId,userId);
    const accounts=await resolveArAccounts(ctx,String(cn.type)==='customer'?['default_revenue','receivable','vat_output']:['payable','default_expense','vat_input']);
    let lines: JournalLineInput[];

    if (String(cn.type) === 'customer') {
      // Customer CN: DR Revenue, CR Accounts Receivable
      const revenueAccount = accounts.chosen.default_revenue!;
      const arAccount = accounts.chosen.receivable!;
      const vatAccount = accounts.chosen.vat_output!;

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
      const apAccount = accounts.chosen.payable!;
      const expenseAccount = accounts.chosen.default_expense!;
      const vatAccount = accounts.chosen.vat_input!;

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

    const entryDate=parentControl.permit.accountingDate;

    // No sourceDocumentId: gl_journal_entries.source_document_id has an FK to
    // captured_documents(id) only (migration 409); a credit note's own id
    // would violate it. The credit_note <-> journal entry link is instead
    // persisted below via credit_notes.gl_journal_entry_id.
    const je = await createJournalEntry(companyId, {
      entryDate,
      description: `Credit note ${cn.credit_note_number}`,
      source: 'auto_credit_note',
      sourceRecordId: id,
      lines,
    }, userId, actorMeta(opts));
    await registerGeneratedJournal(ctx,parentControl,je.id,'journal.post');
    await postJournalEntry(companyId,je.id,userId,{parentControl});

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
        await mutateArRelatedEntity(ctx,applyTarget.table==='customer'?'customer_invoice':'supplier_invoice',String(applyTarget.id),parentControl,'credit_note_applied',async()=>{
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
        });
      }
    }
    const autoApplied = appliedAmount > 0;

    // applied_amount records what was ACTUALLY added above, so cancel reverses
    // the recorded figure instead of re-deriving one. It is MIN(total,
    // outstanding), NOT the face value — the cap a few lines up is the whole
    // reason this column exists separately from total_amount, and anything
    // reporting the credit a customer received must read this one.
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


export async function approveCreditNote(companyId:string,id:string,userId:string,opts?:PostingActorOpts&ArApprovalOptions):Promise<CreditNote>{
 const parent={entityType:'credit_note',entityId:id,operation:'credit_note.approve'} as const;
 return runArControlled(companyId,userId,parent,opts,permit=>approveCreditNoteEffect(companyId,id,userId,opts,{permit,parent}));
}
