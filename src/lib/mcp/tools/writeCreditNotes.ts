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
 *                    (a DRAFT is cancelled with no journal at all: `cancelDraft` below)
 *
 * The sharp edge worth knowing before reading further: approving a note that
 * carries an invoice link does NOT stop at the ledger. `approveCreditNote`
 * also adds the note's total to that invoice's `amount_paid` and lands the note
 * in `applied` rather than `approved`. So one `approve_credit_note` call can
 * reduce a customer's outstanding balance — which is why it sits behind
 * `write:post` and is stamped for `list_agent_postings`.
 */
import type { McpTool, McpToolContext, McpToolResult } from '../types';
import type { CreditNote } from '@/modules/accounting/types/ar.types';
import { MUTATION_ARG_SCHEMA } from '@/lib/mcp/contracts';
import { CreditNoteDeleteRefusal } from '@/modules/accounting/services/ar/creditNoteDeleteService';
import { cancelDraftCreditNote } from '@/modules/accounting/services/ar/creditNoteDraftCancelService';
import { inRolledBackSavepoint } from '@/modules/accounting/services/core/rolledBackSavepoint';
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
import { agentApprovalRefusal } from '@/modules/accounting/services/gl/approvalUnattended';
import { creditNoteApprovalType } from '@/modules/accounting/services/gl/approvalDocumentTypes';
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
    + 'Pass auto_apply "linked" to skip the FIFO walk and apply only to the linked document (nothing, if there is no link), or "none" to apply NOTHING, not even to the linked document: the note posts and the whole credit stays on account for apply_credit_note. '
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
          '"fifo" (default) applies the remainder to the entity\'s open documents oldest first; "linked" applies only to the linked document; "none" applies nothing (the credit stays on account).',
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
    // R-035 (Q6): a note an enforced approval rule of its type governs is
    // refused from this read too — an agent can neither raise nor decide the
    // approval it needs.
    const approvalRefusal = await agentApprovalRefusal(ctx.companyId, creditNoteApprovalType(note.type), id);
    if (approvalRefusal) return toolError(approvalRefusal);

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
    'Cancel a credit note. Requires the write:post permission. ' +
    'An approved, partially applied or applied note: REVERSES its journal entry with a reversing entry (the original stays posted) and un-applies the credit from EVERY document it was applied to — each one\'s amount_paid drops back and its status is recomputed, in the same transaction. ' +
    'A DRAFT note is cancelled WITHOUT a journal: it is set to cancelled, nothing is posted or reversed, no balance moves and the number stays on the books (no gap). That is the way out for a draft that cannot be deleted (delete_draft_credit_note refuses one numbered from the supplier return sequence). ' +
    'A draft is refused when it carries a journal or applied credit (inconsistent data), when a dispute resolution raised it, or when it has a pending approval request. A cancelled note stays cancelled. ' +
    'Run with dry_run first: it runs the real cancel and rolls it back, so it refuses exactly what the live call would, and writes nothing.',
  scope: 'write:invoices',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      credit_note_id: { type: 'string' },
      reason: { type: 'string', description: 'Recorded on the note as cancel_reason' },
      ...MUTATION_ARG_SCHEMA,
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
    const dryRun = args.dry_run === true;
    const reason = strArg(args, 'reason');
    // A draft has no journal to reverse: its own path (ar/creditNoteDraftCancelService), no VAT-lock preflight.
    if (note.status === 'draft') return cancelDraft(ctx, id, reason, dryRun);
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

    const run = () => cancelCreditNote(ctx.companyId, id, ctx.userId, reason, mcpPostingOpts(ctx, 'cancel_credit_note'));
    let updated: CreditNote;
    if (dryRun) {
      // The real cancel in a savepoint that is always rolled back: it meets every guard the live call meets.
      const held: { cn?: CreditNote } = {};
      await inRolledBackSavepoint('mcp_cn_cancel_dry_run', async () => { held.cn = await run(); });
      updated = held.cn!;
    } else {
      updated = await run();
    }

    const out = {
      id: updated.id,
      credit_note_number: updated.creditNoteNumber,
      status: updated.status,
      total_amount: updated.totalAmount,
      // Non-null when the reversal was dated past a locked (filed) VAT period.
      reversal_date_roll: roll,
    };
    return dryRun ? { ...ok({ dry_run: true, would_cancel: out }), wroteNothing: true } : ok(out);
  },
};

/**
 * Cancel a DRAFT. Every refusal the service raises comes before its single write, so the typed refusal is safe as a
 * toolError (no write to repeat on retry); anything else is rethrown for the registry's savepoint. The dry run is the
 * same call inside a rolled-back savepoint, so it meets the row lock and every guard.
 */
async function cancelDraft(ctx: McpToolContext, id: string, reason: string | undefined, dryRun: boolean): Promise<McpToolResult> {
  try {
    const opts = mcpPostingOpts(ctx, 'cancel_credit_note');
    let updated: CreditNote;
    if (dryRun) {
      const held: { cn?: CreditNote } = {};
      await inRolledBackSavepoint('mcp_cn_cancel_draft_dry_run', async () => {
        held.cn = await cancelDraftCreditNote(ctx.companyId, id, ctx.userId, reason, opts);
      });
      updated = held.cn!;
    } else {
      updated = await cancelDraftCreditNote(ctx.companyId, id, ctx.userId, reason, opts);
    }
    const out = {
      id: updated.id,
      credit_note_number: updated.creditNoteNumber,
      status: updated.status,
      total_amount: updated.totalAmount,
      reversal_date_roll: null,
      journal_reversed: false,
      note: 'Draft cancelled: no journal was posted or reversed, no balance moved, and the number stays on the books.',
    };
    return dryRun ? { ...ok({ dry_run: true, would_cancel: out }), wroteNothing: true } : ok(out);
  } catch (err) {
    // A missing and a foreign id read alike (the lock read is company-scoped).
    if (err instanceof CreditNoteDeleteRefusal) return toolError(err.code === 'NOT_FOUND' ? NOT_FOUND : err.message);
    throw err;
  }
}
