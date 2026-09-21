/**
 * MCP write tools: `unapply_supplier_payment` and `unapply_credit_note`.
 *
 * Undo a wrong application without voiding the cash or cancelling the note:
 * the document gets its balance back, the allocation row goes, and the payment
 * or note keeps its journal with a larger unapplied remainder. No journal
 * posts. Every refusal is decided from reads by the service's plan (the same
 * plan the dry run returns); a refusal is returned as a toolError because
 * nothing has been written, and anything else is rethrown so the registry
 * unwinds the savepoint.
 */
import type { McpTool, McpToolResult } from '../types';
import { MUTATION_ARG_SCHEMA, type DryRunEffect, type DryRunResult } from '@/lib/mcp/contracts';
import {
  UnapplyRefusal, planSupplierPaymentUnapply, unapplySupplierPayment, type UnapplyLine,
} from '@/modules/accounting/services/ap/supplierPaymentUnapply';
import { planCreditNoteUnapply, unapplyCreditNote } from '@/modules/accounting/services/shared/creditNoteUnapply';
import { guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

const COMMON_TAIL =
  'Posts NO journal — only balances move — and is itself undone by applying again. '
  + 'Run with dry_run first: it lists every document whose balance would move and writes nothing.';

export const unapplySupplierPaymentTool: McpTool = {
  name: 'unapply_supplier_payment',
  description:
    "Take a PROCESSED supplier payment's cash back off one bill (invoice_id) or every bill it is "
    + 'applied to, WITHOUT voiding the payment: each bill gets its balance back and the payment keeps '
    + 'its journal with the amount as an unapplied remainder (list_unapplied_payments shows it; '
    + 'apply_payment_to_supplier_invoice re-applies it). Use it to correct a wrong oldest-first '
    + 'application; use void_payment only when the cash itself is wrong. Refused for a draft or '
    + 'approved payment (edit or cancel it), a batch member (undo it through its batch), or a bill the '
    + `payment is not applied to. ${COMMON_TAIL}`,
  scope: 'write:invoices',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      payment_id: { type: 'string', description: 'A processed supplier payment (list_supplier_payments).' },
      invoice_id: { type: 'string', description: 'Only this bill. Omit to take back every application.' },
      ...MUTATION_ARG_SCHEMA,
    },
    required: ['payment_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const paymentId = strArg(args, 'payment_id');
    if (!paymentId) return toolError('payment_id is required');
    const bad = guardCastableArgs(args, { uuid: ['payment_id', 'invoice_id'] });
    if (bad) return bad;
    const input = { paymentId, invoiceId: strArg(args, 'invoice_id') };
    return run(async () => {
      if (args.dry_run === true) {
        const p = await planSupplierPaymentUnapply(ctx.companyId, input);
        return dryRun(p.lines, 'supplier_invoice', {
          entityId: p.paymentId, documentNumber: p.paymentNumber, field: 'payment_unapplied_amount',
          before: p.unappliedAfter - p.amountUnapplied, after: p.unappliedAfter,
        });
      }
      const r = await unapplySupplierPayment(ctx.companyId, input, ctx.userId);
      return ok({
        journal_posted: false,
        payment_id: r.paymentId,
        payment_number: r.paymentNumber,
        amount_unapplied: r.amountUnapplied,
        payment_unapplied_after: r.unappliedAfter,
        payment_status: r.paymentStatusAfter,
        invoices: r.lines.map(lineReply),
      });
    });
  },
};

export const unapplyCreditNoteTool: McpTool = {
  name: 'unapply_credit_note',
  description:
    "Take an approved credit note's credit back off one document (invoice_id) or every document it is "
    + 'applied to, WITHOUT cancelling the note: each document gets its balance back and the note keeps '
    + 'its journal with the amount as on-account credit (apply_credit_note re-applies it). Use it to '
    + 'correct a wrong oldest-first application; use cancel_credit_note only when the note itself is '
    + 'wrong. Refused for a draft or cancelled note, a note whose applied amount has no allocation rows '
    + `behind it (a legacy row — reconcile by hand), or a document the note is not applied to. ${COMMON_TAIL}`,
  scope: 'write:invoices',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      credit_note_id: { type: 'string', description: 'An approved credit note (list_credit_notes).' },
      invoice_id: { type: 'string', description: 'Only this document. Omit to take back every application.' },
      ...MUTATION_ARG_SCHEMA,
    },
    required: ['credit_note_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const creditNoteId = strArg(args, 'credit_note_id');
    if (!creditNoteId) return toolError('credit_note_id is required');
    const bad = guardCastableArgs(args, { uuid: ['credit_note_id', 'invoice_id'] });
    if (bad) return bad;
    const input = { creditNoteId, invoiceId: strArg(args, 'invoice_id') };
    return run(async () => {
      if (args.dry_run === true) {
        const p = await planCreditNoteUnapply(ctx.companyId, input);
        const entityType = p.side === 'customer' ? 'customer_invoice' as const : 'supplier_invoice' as const;
        return dryRun(p.lines, entityType, {
          entityId: p.creditNoteId, documentNumber: p.creditNoteNumber, field: 'credit_note_applied_amount',
          before: p.noteAppliedAfter + p.amountUnapplied, after: p.noteAppliedAfter,
        });
      }
      const r = await unapplyCreditNote(ctx.companyId, input, ctx.userId);
      return ok({
        journal_posted: false,
        credit_note_id: r.creditNoteId,
        credit_note_number: r.creditNoteNumber,
        type: r.side,
        amount_unapplied: r.amountUnapplied,
        note_applied_after: r.noteAppliedAfter,
        note_status: r.noteStatusAfter,
        invoices: r.lines.map(lineReply),
      });
    });
  },
};

/** Only a refusal becomes a toolError — it is raised from reads, before any write. */
async function run(fn: () => Promise<McpToolResult>): Promise<McpToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof UnapplyRefusal) return toolError(err.message);
    throw err;
  }
}

function lineReply(l: UnapplyLine) {
  return {
    invoice_id: l.invoiceId,
    invoice_number: l.invoiceNumber,
    amount_unapplied: l.amount,
    outstanding_before: l.outstandingBefore,
    outstanding_after: l.outstandingAfter,
  };
}

/** `wroteNothing` keeps the idempotency key free for the real call. */
function dryRun(
  lines: readonly UnapplyLine[],
  entityType: 'customer_invoice' | 'supplier_invoice',
  source: Omit<DryRunEffect, 'entityType'>,
): McpToolResult {
  const effects: DryRunEffect[] = [
    ...lines.map((l) => ({
      entityType, entityId: l.invoiceId, documentNumber: l.invoiceNumber,
      field: 'outstanding', before: l.outstandingBefore, after: l.outstandingAfter,
    })),
    // The contract has no payment/credit-note entity type; the source is
    // reported against the document side it settles, as the apply tools do.
    { entityType, ...source },
  ];
  const result: DryRunResult = { dryRun: true, journals: [], skipped: [], effects, journalsTotal: 0, truncated: false };
  return { ...ok(result), wroteNothing: true };
}
