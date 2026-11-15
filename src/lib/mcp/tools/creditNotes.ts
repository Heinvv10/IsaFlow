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
 * Free, like every other read — but NOT unscoped. Both tools carry
 * `read:invoices`, the same scope `list_invoices` / `list_supplier_invoices`
 * require: a credit note names a customer or supplier and an amount, so it is
 * invoice-grade data. `scope: null` (which only `company_profile` uses, and
 * annotates as "identity, not data") would have let a token minted with, say,
 * `read:bank-tx` alone — or with no read scopes at all — pull every customer
 * name, supplier name and invoice number in the tenant.
 */
import type { McpTool } from '../types';
import {
  getCreditNotes,
  getCreditNoteById,
} from '@/modules/accounting/services/ar/creditNoteService';
import {
  CREDIT_NOTE_GROUP_BY,
  summariseCreditNotes,
} from '@/modules/accounting/services/ar/creditNoteSummaryService';
import type { CreditNote, CreditNoteStatus } from '@/modules/accounting/types/ar.types';
import { OFFSET_SCHEMA, nextOffsetFromTotal, parseOffset } from './pageArgs';
import { SUMMARY_DETAIL_SCHEMA, groupBySchema, parseSummaryRequest, summaryBody } from './summaryMode';
import {
  NOT_FOUND,
  clampLimit,
  guardCastableArgs,
  ok,
  strArg,
  toolError,
} from './toolHelpers';

const STATUSES = ['draft', 'approved', 'partially_applied', 'applied', 'cancelled'] as const;
const TYPES = ['customer', 'supplier'] as const;
/** A credit-note row is about 700 bytes of JSON: 75 of them stay well under a client's ~90 KB result limit (reason is free text, so keep headroom). */
export const CREDIT_NOTES_DEFAULT_LIMIT = 50;
export const CREDIT_NOTES_MAX_LIMIT = 75;

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
    'Newest credit_date first. A note with status "applied" has ALREADY been credited against its linked invoice; "approved" means posted to the ledger but not applied to any invoice; "draft" posts nothing. ' +
    `Returns {credit_notes, total, next_offset}: up to limit rows (default ${CREDIT_NOTES_DEFAULT_LIMIT}, max ${CREDIT_NOTES_MAX_LIMIT}); when next_offset is not null, call again with offset=next_offset for the next page. ` +
    'To total a large book without paging, use detail="summary" (count, total_amount, tax_amount and applied_amount over the WHOLE filter set, no rows) ' +
    'and group_by=status|type|party|month (party = the customer or supplier; groups sum to the totals; at most 200 groups, the rest summed in other). A summary takes no offset.',
  scope: 'read:invoices',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: [...TYPES] },
      status: { type: 'string', enum: [...STATUSES] },
      limit: {
        type: 'integer', minimum: 1, maximum: CREDIT_NOTES_MAX_LIMIT,
        description: `Default ${CREDIT_NOTES_DEFAULT_LIMIT}, max ${CREDIT_NOTES_MAX_LIMIT}`,
      },
      offset: OFFSET_SCHEMA,
      detail: SUMMARY_DETAIL_SCHEMA,
      group_by: groupBySchema(CREDIT_NOTE_GROUP_BY),
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

    const wanted = parseSummaryRequest(args, CREDIT_NOTE_GROUP_BY);
    if (!wanted.ok) return wanted.error;
    const offset = parseOffset(args);
    if (typeof offset === 'string') return toolError(offset);
    const scope = {
      type: type as (typeof TYPES)[number] | undefined,
      status: status as CreditNoteStatus | undefined,
    };
    if (wanted.summary) {
      return ok(summaryBody(await summariseCreditNotes(ctx.companyId, scope, wanted.groupBy), wanted.groupBy));
    }

    const result = await getCreditNotes(ctx.companyId, {
      ...scope,
      limit: clampLimit(args, CREDIT_NOTES_DEFAULT_LIMIT, CREDIT_NOTES_MAX_LIMIT),
      offset,
    });

    return ok({
      credit_notes: result.creditNotes.map(compact),
      total: result.total,
      next_offset: nextOffsetFromTotal(offset, result.creditNotes.length, result.total),
    });
  },
};

export const getCreditNoteTool: McpTool = {
  name: 'get_credit_note',
  description:
    'Fetch one credit note by id. Use list_credit_notes to find the id.',
  scope: 'read:invoices',
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
