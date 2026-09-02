/**
 * MCP read tools: credit notes (AR and AP).
 *
 * One table, `credit_notes`, carries both directions and is discriminated by
 * `type` — a customer note reduces a receivable, a supplier note reduces a
 * payable. Neither was reachable over the connector, which left an agent able
 * to raise invoices and bills it could never correct: the only remaining route
 * was a hand-built journal, which moves the GL but not the subledger, so
 * `aged_debtors` / `aged_creditors` keep showing the uncredited balance
 * forever.
 *
 * Free, like every other read.
 */
import type { McpTool } from '../types';
import {
  getCreditNotes,
  getCreditNoteById,
} from '@/modules/accounting/services/ar/creditNoteService';
import type { CreditNote, CreditNoteStatus } from '@/modules/accounting/types/ar.types';
import {
  NOT_FOUND,
  clampLimit,
  guardCastableArgs,
  ok,
  strArg,
  toolError,
} from './toolHelpers';

const STATUSES = ['draft', 'approved', 'applied', 'cancelled'] as const;
const TYPES = ['customer', 'supplier'] as const;

/**
 * Map DOWN to the fields an agent can act on.
 *
 * `gl_journal_entry_id` is the only proof the note reached the ledger — status
 * alone cannot say so, because a draft and a note whose posting failed look
 * identical from the subledger. `status: 'applied'` additionally means the
 * linked invoice's `amount_paid` was already bumped, so an agent must not
 * treat an applied note as still-available credit.
 */
function compact(cn: CreditNote): Record<string, unknown> {
  return {
    id: cn.id,
    credit_note_number: cn.creditNoteNumber,
    type: cn.type,
    client_id: cn.clientId ?? null,
    client_name: cn.clientName ?? null,
    supplier_id: cn.supplierId ?? null,
    supplier_name: cn.supplierName ?? null,
    customer_invoice_id: cn.customerInvoiceId ?? null,
    supplier_invoice_id: cn.supplierInvoiceId ?? null,
    invoice_number: cn.invoiceNumber ?? null,
    credit_date: cn.creditDate,
    reason: cn.reason ?? null,
    subtotal: cn.subtotal,
    tax_rate: cn.taxRate,
    tax_amount: cn.taxAmount,
    total_amount: cn.totalAmount,
    // What was actually credited to the linked invoice. The apply path caps at
    // the invoice's outstanding balance, so an agent must not read
    // total_amount as "credit consumed" — the difference is still available.
    applied_amount: cn.appliedAmount,
    status: cn.status,
    gl_journal_entry_id: cn.glJournalEntryId ?? null,
  };
}

export const listCreditNotesTool: McpTool = {
  name: 'list_credit_notes',
  description:
    'List credit notes. Filter by type ("customer" reduces a receivable, "supplier" reduces a payable) and by status. ' +
    'Newest credit_date first. A note with status "applied" has ALREADY been credited against its linked invoice; "approved" means posted to the ledger but not applied to any invoice; "draft" posts nothing.',
  scope: null,
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: [...TYPES] },
      status: { type: 'string', enum: [...STATUSES] },
      limit: { type: 'number', minimum: 1, maximum: 200, description: 'Default 50, max 200' },
      offset: { type: 'number', minimum: 0 },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const type = strArg(args, 'type');
    if (type && !TYPES.includes(type as (typeof TYPES)[number])) {
      return toolError(`type must be one of: ${TYPES.join(', ')}`);
    }
    const status = strArg(args, 'status');
    if (status && !STATUSES.includes(status as CreditNoteStatus)) {
      return toolError(`status must be one of: ${STATUSES.join(', ')}`);
    }

    const offsetRaw = args.offset;
    let offset = 0;
    if (offsetRaw !== undefined && offsetRaw !== null) {
      offset = Number(offsetRaw);
      if (!Number.isInteger(offset) || offset < 0) return toolError('offset must be a non-negative integer');
    }

    const result = await getCreditNotes(ctx.companyId, {
      type: type as (typeof TYPES)[number] | undefined,
      status: status as CreditNoteStatus | undefined,
      limit: clampLimit(args, 50, 200),
      offset,
    });

    return ok({
      credit_notes: result.creditNotes.map(compact),
      total: result.total,
    });
  },
};

export const getCreditNoteTool: McpTool = {
  name: 'get_credit_note',
  description:
    'Fetch one credit note by id, customer or supplier. Use list_credit_notes to find the id.',
  scope: null,
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      credit_note_id: { type: 'string', description: 'Credit note UUID' },
    },
    required: ['credit_note_id'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = strArg(args, 'credit_note_id');
    if (!id) return toolError('credit_note_id is required');
    const bad = guardCastableArgs(args, { uuid: ['credit_note_id'] });
    if (bad) return bad;

    const note = await getCreditNoteById(ctx.companyId, id);
    if (!note) return toolError(NOT_FOUND);
    return ok(compact(note));
  },
};
