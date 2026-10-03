/**
 * MCP write tools: credit notes (AR and AP).
 *
 * `create_credit_note` posts nothing (status stays `draft`), so it is `write`
 * but not `requiresPost`. `approve_credit_note` and `cancel_credit_note` both
 * move the ledger and additionally require `write:post`:
 *
 *   customer note  approve → DR Revenue + DR VAT Output / CR Accounts Receivable
 *   supplier note  approve → DR Accounts Payable / CR Expense + CR VAT Input
 *   cancel         → reverses that journal and un-applies the invoice credit
 *
 * The sharp edge worth knowing before reading further: approving a note that
 * carries an invoice link does NOT stop at the ledger. `approveCreditNote`
 * also adds the note's total to that invoice's `amount_paid` and lands the note
 * in `applied` rather than `approved`. So one `approve_credit_note` call can
 * reduce a customer's outstanding balance — which is why it sits behind
 * `write:post` and is stamped for `list_agent_postings`.
 */
import type { McpTool } from '../types';
import {
  approveCreditNote,
  cancelCreditNote,
  getCreditNoteById,
} from '@/modules/accounting/services/ar/creditNoteService';
import { validateSystemAccounts } from '@/modules/accounting/services/gl/systemAccountResolver';
import { getJournalEntryById } from '@/modules/accounting/services/gl/journalEntryService';
import { brokenChainMessage, findJournalChainHead } from '@/modules/accounting/services/shared/journalChainHead';
import { ReversalBeforeOriginalError, resolveReversalDateDetailed, type VatLockRoll } from '@/modules/accounting/services/gl/journalEntryReversalDate';
import { VatPeriodLockedError } from '@/modules/accounting/services/gl/journalVatLockGuard';
import { fmtDate } from '@/lib/fmtDate';
import { mcpPostingOpts } from '../mcpActor';
import {
  CREDIT_NOTE_AUTO_APPLY,
  listCreditNoteAllocations,
  parseCreditNoteAutoApply,
} from '@/modules/accounting/services/shared/creditNoteFifo';
import { NOT_FOUND, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

// Re-exported so the registry and the tests keep ONE import surface for the
// three credit-note write tools — see writeCreditNotesCreate.ts.
export { createCreditNoteTool } from './writeCreditNotesCreate';

export const approveCreditNoteTool: McpTool = {
  name: 'approve_credit_note',
  description:
    'Approve a DRAFT credit note and POST it to the ledger. Requires the write:post permission. ' +
    'Customer note: DR Revenue + DR VAT Output / CR Accounts Receivable. Supplier note: DR Accounts Payable / CR Expense + CR VAT Input. ' +
    'Approving also APPLIES the note. A linked invoice is settled first, capped at its outstanding balance; the REMAINDER is then applied FIFO to that same customer\'s or supplier\'s other open documents, oldest first. '
    + 'Pass auto_apply "none" to skip the FIFO walk and apply only to the linked document (or nothing, if there is no link). '
    + 'The resulting status is DERIVED: "approved" when nothing was applied, "partially_applied" when some of the face value is still on account, "applied" when all of it was consumed. '
    + 'applied_amount is what was consumed and applied_to_invoice_ids names every document it settled. Whatever is left is on-account credit, which aged_debtors / aged_creditors report as unapplied and net off. Reverse the whole thing with cancel_credit_note.',
  scope: 'write:invoices',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      credit_note_id: { type: 'string' },
      auto_apply: {
        type: 'string',
        enum: [...CREDIT_NOTE_AUTO_APPLY],
        description:
          '"fifo" (default) applies the remainder to the entity\'s open documents oldest first; "none" applies only to the linked document.',
      },
      idempotency_key: { type: 'string' },
    },
    required: ['credit_note_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = strArg(args, 'credit_note_id');
    if (!id) return toolError('credit_note_id is required');
    const bad = guardCastableArgs(args, { uuid: ['credit_note_id'] });
    if (bad) return bad;

    // A typo'd auto_apply is REFUSED, never coerced to the default: an agent
    // that meant 'none' and typed 'off' would otherwise be told the note was
    // approved while the FIFO walk had already spent it.
    const autoApply = args.auto_apply === undefined
      ? 'fifo' as const
      : parseCreditNoteAutoApply(args.auto_apply);
    if (autoApply === null) {
      return toolError(`auto_apply must be one of: ${CREDIT_NOTE_AUTO_APPLY.join(', ')}`);
    }

    // Both refusals are answered from a READ so the service call below needs no
    // catch. approveCreditNote raises the status one itself, but a
    // `catch -> toolError` cannot tell it from a failure AFTER the journal was
    // posted — and a refusal is audited with a NULL idempotency key, so the
    // agent's retry on that key would post the note a second time.
    const note = await getCreditNoteById(ctx.companyId, id);
    if (!note) return toolError(NOT_FOUND);
    if (note.status !== 'draft') {
      return toolError(`Cannot approve credit note with status: ${note.status}`);
    }

    // A missing system account is the likeliest reason an approve fails, and it
    // is the one an agent can actually do something about (create_gl_account
    // with the right subtype). Left to throw, it reaches the registry as
    // GENERIC_FAILURE naming nothing — so the agent retries the same call
    // forever against a company that will never be able to answer it. Refusing
    // here is pre-write and names the subtypes.
    const NEEDED = note.type === 'customer'
      ? ['default_revenue', 'receivable', 'vat_output']
      : ['payable', 'default_expense', 'vat_input'];
    const missing = (await validateSystemAccounts(ctx.companyId)).filter((k) => NEEDED.includes(k));
    if (missing.length > 0) {
      return toolError(
        `Cannot approve: this company has no GL account with subtype ${missing.join(', ')}. `
        + 'Create one with create_gl_account (needs the write:accounts permission), then retry.',
      );
    }

    // No catch beyond that: a closed period or a database failure must reach
    // the registry's savepoint rather than being flattened into a tool error
    // that keeps a partially posted journal.
    const updated = await approveCreditNote(ctx.companyId, id, ctx.userId, {
      ...mcpPostingOpts(ctx, 'approve_credit_note'),
      autoApply,
    });

    return ok({
      id: updated.id,
      credit_note_number: updated.creditNoteNumber,
      type: updated.type,
      status: updated.status,
      total_amount: updated.totalAmount,
      gl_journal_entry_id: updated.glJournalEntryId ?? null,
      // What was CONSUMED and what is left. Saying so explicitly stops an agent
      // reading 'approved' vs 'applied' as cosmetic and then looking for a
      // second apply step that would double-credit a document.
      applied_amount: updated.appliedAmount,
      unapplied_amount: Math.round((updated.totalAmount - updated.appliedAmount) * 100) / 100,
      // Every document this note settled — the FIFO walk can settle several, so
      // the old single id could only ever name one. Ordered by invoice id, not
      // by application: all the applications share one transaction timestamp.
      applied_to_invoice_ids: (await listCreditNoteAllocations(ctx.companyId, id))
        .map((l) => ({ invoice_id: l.invoiceId, amount: l.amount })),
    });
  },
};

export const cancelCreditNoteTool: McpTool = {
  name: 'cancel_credit_note',
  description:
    'Cancel an approved or applied credit note. Requires the write:post permission. ' +
    'REVERSES the note\'s journal entry with a reversing entry (the original stays posted) and un-applies the credit from EVERY document it was applied to — each one\'s amount_paid drops back and its status is recomputed, in the same transaction. ' +
    'Only "approved", "partially_applied" and "applied" notes can be cancelled; a draft has nothing to reverse.',
  scope: 'write:invoices',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      credit_note_id: { type: 'string' },
      reason: { type: 'string', description: 'Recorded on the note as cancel_reason' },
      idempotency_key: { type: 'string' },
    },
    required: ['credit_note_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = strArg(args, 'credit_note_id');
    if (!id) return toolError('credit_note_id is required');
    const bad = guardCastableArgs(args, { uuid: ['credit_note_id'] });
    if (bad) return bad;

    // Same reasoning as approve: refuse from a read, never from a catch.
    const note = await getCreditNoteById(ctx.companyId, id);
    if (!note) return toolError(NOT_FOUND);
    if (note.status !== 'approved' && note.status !== 'partially_applied' && note.status !== 'applied') {
      return toolError(`Cannot cancel credit note with status: ${note.status}`);
    }

    // Also from a read: the date the reversal will carry. reverseJournalEntry
    // resolves it the same way, so this is the roll past a locked (filed) VAT
    // period it will make — or the refusal it would raise mid-write when no
    // date up to today can take the contra.
    // The entry is the journal's reversal-chain HEAD while the chain stands, as
    // the cancel reverses it (D8); a broken chain is refused here, from the read.
    let roll: VatLockRoll | null = null;
    const chain = note.glJournalEntryId ? await findJournalChainHead(ctx.companyId, note.glJournalEntryId) : null;
    if (chain?.kind === 'broken') return toolError(brokenChainMessage(note.glJournalEntryId!, chain));
    const je = chain?.standing ? await getJournalEntryById(ctx.companyId, chain.id) : null;
    if (je && je.status === 'posted' && !je.reversedAt && je.lines && je.lines.length > 0) {
      try {
        roll = (await resolveReversalDateDetailed(ctx.companyId, fmtDate(je.entryDate), undefined, je.lines)).vatLockRoll;
      } catch (err) {
        if (err instanceof VatPeriodLockedError || err instanceof ReversalBeforeOriginalError) return toolError(err.message);
        throw err;
      }
    }

    const updated = await cancelCreditNote(
      ctx.companyId,
      id,
      ctx.userId,
      strArg(args, 'reason'),
      mcpPostingOpts(ctx, 'cancel_credit_note'),
    );

    return ok({
      id: updated.id,
      credit_note_number: updated.creditNoteNumber,
      status: updated.status,
      total_amount: updated.totalAmount,
      // Non-null when the reversal was dated past a locked (filed) VAT period.
      reversal_date_roll: roll,
    });
  },
};
