/**
 * MCP write tool: `adjust_credit_note_application`.
 *
 * Set how much of an APPROVED credit note is applied to ONE document: 0 takes
 * the application back, less takes part of it back, more applies more. The
 * subledger moves (the allocation row, the document's amount_paid and status,
 * the note's applied amount and status) and NO journal posts — the note's own
 * journal carries the credit, exactly as for apply_credit_note and
 * unapply_credit_note, whose row writers this reuses.
 *
 * Every refusal is decided from reads by the service's plan, run identically
 * by the dry run; a `CreditNoteAdjustRefusal` is therefore a toolError, and
 * anything else is rethrown so the registry unwinds the savepoint.
 */
import type { McpTool, McpToolResult } from '../types';
import { MUTATION_ARG_SCHEMA, type DryRunEffect, type DryRunResult } from '@/lib/mcp/contracts';
import {
  CreditNoteAdjustRefusal, adjustCreditNoteApplication, planCreditNoteApplicationAdjust,
  type CreditNoteAdjustResult,
} from '@/modules/accounting/services/shared/creditNoteApplicationAdjust';
import { NOT_FOUND, guardCastableArgs, hasWholeCents, ok, strArg, toolError } from './toolHelpers';

export const adjustCreditNoteApplicationTool: McpTool = {
  name: 'adjust_credit_note_application',
  description:
    "Change how much of an APPROVED credit note is applied to ONE document (document_id): a customer invoice for "
    + 'a customer note, a supplier bill for a supplier note. new_amount is what the note should have applied to '
    + 'that document afterwards: 0 takes the application back (as unapply_credit_note), less takes part of it '
    + 'back, more applies more (the document need not carry the note yet). An increase must fit the note\'s '
    + 'unapplied credit, the document\'s outstanding balance AND what the note\'s journal posted; it is refused, '
    + 'never capped. Refused for a draft or cancelled note, a document of another customer/supplier, a document '
    + 'that is not approved, a note whose journal is missing or reversed, and an unchanged amount. '
    + 'Posts NO journal: the note\'s journal posted at approval (returned as credit_note_journal_id); only '
    + 'balances move. Undo by calling again with new_amount = applied_before. Run with dry_run first: it reports '
    + 'every balance that would move and writes nothing.',
  scope: 'write:invoices',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      credit_note_id: { type: 'string', description: 'An approved credit note, from list_credit_notes.' },
      document_id: {
        type: 'string',
        description: 'The customer invoice (customer note) or supplier bill (supplier note) whose application changes.',
      },
      new_amount: {
        type: 'number',
        minimum: 0,
        description: 'What the note should have applied to this document afterwards, in whole cents. 0 = none.',
      },
      ...MUTATION_ARG_SCHEMA,
    },
    required: ['credit_note_id', 'document_id', 'new_amount', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const creditNoteId = strArg(args, 'credit_note_id');
    const documentId = strArg(args, 'document_id');
    if (!creditNoteId) return toolError('credit_note_id is required');
    if (!documentId) return toolError('document_id is required');
    const bad = guardCastableArgs(args, { uuid: ['credit_note_id', 'document_id'] });
    if (bad) return bad;
    const newAmount = args.new_amount;
    if (typeof newAmount !== 'number' || newAmount < 0 || !hasWholeCents(newAmount)) {
      return toolError('new_amount must be zero or a positive amount in whole cents');
    }
    const input = { creditNoteId, documentId, newAmount };
    try {
      if (args.dry_run === true) {
        return dryRunResult(await planCreditNoteApplicationAdjust(ctx.companyId, input));
      }
      return ok(reply(await adjustCreditNoteApplication(ctx.companyId, input, ctx.userId)));
    } catch (err) {
      // Raised from reads, before any write. A missing and a foreign id read the
      // same: the reads are company-scoped, and distinct text is an existence oracle.
      if (err instanceof CreditNoteAdjustRefusal) {
        return toolError(err.message.endsWith('not found.') ? NOT_FOUND : err.message);
      }
      throw err;
    }
  },
};

function reply(r: CreditNoteAdjustResult) {
  return {
    journal_posted: false,
    reversal_journal_id: null,
    new_journal_id: null,
    credit_note_journal_id: r.creditNoteJournalId,
    credit_note_id: r.creditNoteId,
    credit_note_number: r.creditNoteNumber,
    type: r.side,
    document_id: r.documentId,
    document_number: r.documentNumber,
    applied_before: r.appliedBefore,
    applied_after: r.appliedAfter,
    change: r.change,
    document_outstanding_before: r.documentOutstandingBefore,
    document_outstanding_after: r.documentOutstandingAfter,
    note_total: r.noteTotal,
    note_posted: r.notePosted,
    note_applied_before: r.noteAppliedBefore,
    note_applied_after: r.noteAppliedAfter,
    note_remainder_after: r.noteRemainderAfter,
    note_status_after: r.noteStatusAfter,
    undo: { credit_note_id: r.creditNoteId, document_id: r.documentId, new_amount: r.appliedBefore },
  };
}

/** `wroteNothing` keeps the idempotency key free for the real call — CONTRACTS §6. */
function dryRunResult(r: CreditNoteAdjustResult): McpToolResult {
  const entityType = r.side === 'customer' ? 'customer_invoice' as const : 'supplier_invoice' as const;
  const effects: DryRunEffect[] = [
    {
      entityType, entityId: r.documentId, documentNumber: r.documentNumber,
      field: 'outstanding', before: r.documentOutstandingBefore, after: r.documentOutstandingAfter,
    },
    {
      entityType, entityId: r.documentId, documentNumber: r.documentNumber,
      field: 'credit_note_applied', before: r.appliedBefore, after: r.appliedAfter,
    },
    // The contract has no credit-note entity type; the note is reported against
    // the document side it credits, as apply_credit_note does.
    {
      entityType, entityId: r.creditNoteId, documentNumber: r.creditNoteNumber,
      field: 'credit_note_applied_amount', before: r.noteAppliedBefore, after: r.noteAppliedAfter,
    },
  ];
  const result: DryRunResult = { dryRun: true, journals: [], skipped: [], effects, journalsTotal: 0, truncated: false };
  return { ...ok(result), wroteNothing: true };
}
