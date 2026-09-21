/**
 * MCP write tool: `apply_credit_note`.
 *
 * Put an APPROVED credit note's unused credit against ONE document the agent
 * names — a customer invoice for a customer note, a supplier bill for a
 * supplier note. Approval and `auto_apply_unapplied` apply oldest-first; a
 * credit note imported from Sage usually belongs to one specific invoice, and
 * FIFO would settle the wrong documents with the right total.
 *
 * Posts NO journal. The note's journal moved the control account when it was
 * approved; this moves only the subledger (the allocation row, the document's
 * amount_paid and status, the note's applied_amount and status). It is written
 * through the same engine approval uses, so cancel_credit_note reverses it.
 *
 * Every refusal is decided from reads before anything is written, by the same
 * code the dry run runs (`planCreditNoteToDocument`). A `CreditNoteApplyRefusal`
 * is therefore returned as a toolError; anything else is rethrown so the
 * registry unwinds the savepoint.
 */
import type { McpTool } from '../types';
import { MUTATION_ARG_SCHEMA, type DryRunEffect, type DryRunResult } from '@/lib/mcp/contracts';
import {
  CreditNoteApplyRefusal,
  applyCreditNoteToDocument,
  planCreditNoteToDocument,
  type CreditNoteToDocumentResult,
} from '@/modules/accounting/services/shared/creditNoteDocumentApply';
import { NOT_FOUND, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

const TOOL = 'apply_credit_note';

export const applyCreditNoteTool: McpTool = {
  name: TOOL,
  description:
    "Apply an APPROVED credit note's unused credit to ONE document you name: a customer invoice "
    + 'for a customer credit note, a supplier bill for a supplier credit note. Use it when the note '
    + 'belongs to a specific invoice — approve_credit_note and auto_apply_unapplied apply oldest-first '
    + 'instead. The document must belong to the same customer/supplier as the note and be approved '
    + 'and unpaid. Applies the whole remainder by default, capped at the document\'s outstanding '
    + 'balance; pass amount to apply less. Whatever is not applied stays on the note as on-account '
    + 'credit, and the note can be applied again to another document. '
    + 'Posts NO journal — the note\'s journal posted at approval; only balances move. '
    + 'Reversible with cancel_credit_note. A note applies to a given document once. '
    + 'Does NOT cover: draft notes (approve_credit_note), cash (apply_payment_to_supplier_invoice / '
    + 'apply_receipt_to_invoice). Run with dry_run first: it reports every balance that would move '
    + 'and writes nothing.',
  scope: 'write:invoices',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      credit_note_id: { type: 'string', description: 'An approved credit note, from list_credit_notes.' },
      invoice_id: {
        type: 'string',
        description: 'The customer invoice (customer note) or supplier bill (supplier note) to credit.',
      },
      amount: {
        type: 'number',
        exclusiveMinimum: 0,
        description: "At most this much. Omit to apply the note's whole remainder (capped by the document).",
      },
      ...MUTATION_ARG_SCHEMA,
    },
    required: ['credit_note_id', 'invoice_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const creditNoteId = strArg(args, 'credit_note_id');
    const invoiceId = strArg(args, 'invoice_id');
    if (!creditNoteId) return toolError('credit_note_id is required');
    if (!invoiceId) return toolError('invoice_id is required');
    const bad = guardCastableArgs(args, { uuid: ['credit_note_id', 'invoice_id'] });
    if (bad) return bad;

    let amount: number | undefined;
    if (args.amount !== undefined && args.amount !== null) {
      amount = typeof args.amount === 'number' ? args.amount : Number.NaN;
      if (!Number.isFinite(amount) || amount <= 0) return toolError('amount must be a positive number');
    }
    const input = { creditNoteId, invoiceId, amount };

    try {
      if (args.dry_run === true) {
        return dryRunResult(await planCreditNoteToDocument(ctx.companyId, input));
      }
      return ok(reply(await applyCreditNoteToDocument(ctx.companyId, input, ctx.userId)));
    } catch (err) {
      // Only a refusal becomes a toolError: it is raised before any write. The
      // same reply for a missing and a foreign id — the reads are
      // company-scoped, and distinct text would be an existence oracle.
      if (err instanceof CreditNoteApplyRefusal) {
        return toolError(err.message.endsWith('not found.') ? NOT_FOUND : err.message);
      }
      throw err;
    }
  },
};

function reply(r: CreditNoteToDocumentResult) {
  return {
    journal_posted: false,
    credit_note_id: r.creditNoteId,
    credit_note_number: r.creditNoteNumber,
    type: r.side,
    invoice_id: r.invoiceId,
    invoice_number: r.invoiceNumber,
    amount_applied: r.amount,
    invoice_outstanding_before: r.invoiceOutstandingBefore,
    invoice_outstanding_after: r.invoiceOutstandingAfter,
    note_total: r.noteTotal,
    note_applied_before: r.noteAppliedBefore,
    note_applied_after: r.noteAppliedAfter,
    note_remainder_after: r.noteRemainderAfter,
    note_status_after: r.noteStatusAfter,
  };
}

/** `wroteNothing` is what keeps the idempotency key free — see CONTRACTS §6. */
function dryRunResult(r: CreditNoteToDocumentResult) {
  const entityType = r.side === 'customer' ? 'customer_invoice' as const : 'supplier_invoice' as const;
  const effects: DryRunEffect[] = [
    {
      entityType, entityId: r.invoiceId, documentNumber: r.invoiceNumber,
      field: 'outstanding', before: r.invoiceOutstandingBefore, after: r.invoiceOutstandingAfter,
    },
    {
      // The contract has no credit-note entity type; the note's remainder is
      // reported against the document side it credits, as the cash tools do
      // for a payment's unapplied amount.
      entityType, entityId: r.creditNoteId, documentNumber: r.creditNoteNumber,
      field: 'credit_note_remainder', before: r.noteTotal - r.noteAppliedBefore, after: r.noteRemainderAfter,
    },
  ];
  const result: DryRunResult = {
    dryRun: true, journals: [], skipped: [], effects, journalsTotal: 0, truncated: false,
  };
  return { ...ok(result), wroteNothing: true };
}
