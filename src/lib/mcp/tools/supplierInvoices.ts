/**
 * MCP read tools: supplier invoices (AP).
 *
 * `list_invoices` / `get_invoice` were both sales-side. With 180 suppliers and
 * no AP documents, `aged_creditors` returned empty and an agent had no way to
 * see whether its own AP writes had landed — which makes the write tools in
 * writeSupplierInvoices.ts unverifiable from the connector.
 *
 * Free, like every other read.
 */
import type { McpTool } from '../types';
import {
  getSupplierInvoices,
  getSupplierInvoiceById,
} from '@/modules/accounting/services/ap/supplierInvoiceService';
import type { SupplierInvoice } from '@/modules/accounting/types/ap.types';
import {
  NOT_FOUND,
  clampLimit,
  guardCastableArgs,
  ok,
  strArg,
  toolError,
} from './toolHelpers';

const STATUSES = [
  'draft', 'pending_approval', 'approved', 'partially_paid', 'paid',
  'disputed', 'cancelled',
] as const;

/**
 * Map DOWN to the fields an agent can act on. `balance` is the outstanding
 * amount and is a stored column here (unlike customer invoices, which have no
 * balance_due column and need total - amount_paid computed).
 */
function compact(inv: SupplierInvoice): Record<string, unknown> {
  return {
    id: inv.id,
    invoice_number: inv.invoiceNumber,
    supplier_id: inv.supplierId,
    supplier_name: inv.supplierName ?? null,
    invoice_date: inv.invoiceDate,
    due_date: inv.dueDate ?? null,
    subtotal: inv.subtotal,
    tax_amount: inv.taxAmount,
    total_amount: inv.totalAmount,
    amount_paid: inv.amountPaid,
    balance: inv.balance,
    status: inv.status,
    reference: inv.reference ?? null,
    // The presence of a journal id is how an agent tells an approved invoice
    // from one that only looks approved — it is the only proof it reached the
    // ledger, and aged_creditors reads the subledger, not the GL.
    gl_journal_entry_id: inv.glJournalEntryId ?? null,
  };
}

export const listSupplierInvoicesTool: McpTool = {
  name: 'list_supplier_invoices',
  description:
    'List supplier invoices (accounts payable / bills). Filter by status, supplier_id, date range, or a free-text search over invoice number, supplier name and reference. ' +
    'Returns {invoices, total, offset} — total is the pre-limit match count, so a truncated page is visible rather than assumed complete. Page with offset.',
  scope: 'read:invoices',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: [...STATUSES] },
      supplier_id: { type: 'string', description: 'Supplier UUID (from list_suppliers)' },
      from_date: { type: 'string', format: 'date', description: 'Invoice date >= this day' },
      to_date: { type: 'string', format: 'date', description: 'Invoice date <= this day' },
      search: { type: 'string', description: 'Free text over invoice number, supplier name and reference' },
      limit: { type: 'number', description: 'Default 50, clamped to 200' },
      offset: { type: 'number' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const status = strArg(args, 'status');
    if (status && !(STATUSES as readonly string[]).includes(status)) {
      return toolError(`status must be one of: ${STATUSES.join(', ')}`);
    }
    // supplier_id lands as ::UUID and the dates as ::DATE inside the WHERE
    // builder. A read tool has NO savepoint, so a 22P02/22008 from here would
    // abort the whole request transaction and the registry's own audit write
    // would then fail with 25P02 — a 500, not a usable error.
    const bad = guardCastableArgs(args, {
      uuid: ['supplier_id'],
      date: ['from_date', 'to_date'],
    });
    if (bad) return bad;

    const offsetRaw = Number(args.offset);
    const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;

    const { invoices, total } = await getSupplierInvoices(ctx.companyId, {
      status: status as (typeof STATUSES)[number] | undefined,
      supplierId: strArg(args, 'supplier_id'),
      fromDate: strArg(args, 'from_date'),
      toDate: strArg(args, 'to_date'),
      search: strArg(args, 'search'),
      limit: clampLimit(args, 50, 200),
      offset,
    });

    return ok({ invoices: invoices.map(compact), total, offset });
  },
};

export const getSupplierInvoiceTool: McpTool = {
  name: 'get_supplier_invoice',
  description:
    'Fetch one supplier invoice by id, including its line items and the gl_account_id each line posts to (resolve codes with list_gl_accounts).',
  scope: 'read:invoices',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      invoice_id: { type: 'string' },
    },
    required: ['invoice_id'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const invoiceId = strArg(args, 'invoice_id');
    if (!invoiceId) return toolError('invoice_id is required');
    const bad = guardCastableArgs(args, { uuid: ['invoice_id'] });
    if (bad) return bad;

    const invoice = await getSupplierInvoiceById(ctx.companyId, invoiceId);
    if (!invoice) return toolError(NOT_FOUND);

    return ok({
      ...compact(invoice),
      notes: invoice.notes ?? null,
      payment_terms: invoice.paymentTerms ?? null,
      items: (invoice.items ?? []).map((item) => ({
        id: item.id,
        description: item.description,
        quantity: item.quantity,
        unit_price: item.unitPrice,
        line_total: item.lineTotal,
        tax_rate: item.taxRate,
        tax_amount: item.taxAmount,
        // Code and name are deliberately not echoed: mapItemRow drops the
        // joined columns, and re-querying them here would be a second read
        // path over gl_accounts. Resolve with list_gl_accounts.
        gl_account_id: item.glAccountId ?? null,
      })),
    });
  },
};
