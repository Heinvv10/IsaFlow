/**
 * MCP write tool: `update_supplier_invoice` — edit a DRAFT bill.
 *
 * Posts nothing (a draft has no journal), so it is `write` but not
 * `requiresPost`. Every refusal comes from `lockAndPlanSupplierInvoiceDraftUpdate`,
 * from reads on the locked row; the apply is called with NO catch, because a
 * catch cannot tell a refusal from a failure part-way through replacing lines.
 */
import type { McpTool } from '../types';
import {
  SupplierInvoiceDraftUpdateRefusal,
  applySupplierInvoiceDraftUpdate,
  lockAndPlanSupplierInvoiceDraftUpdate,
  type SupplierInvoiceDraftPatch,
  type SupplierInvoiceDraftUpdatePlan,
} from '@/modules/accounting/services/ap/supplierInvoiceDraftUpdate';
import { getSupplierInvoiceById } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { SupplierInvoiceLockTimeoutError } from '@/modules/accounting/services/ap/supplierInvoiceLock';
import { MAX_LINES, SUPPLIER_INVOICE_TEXT_LIMITS as TEXT_LIMITS, parseSupplierLines } from './invoiceCreateArgs';
import { NOT_FOUND, castableArgError, ok, strArg, toolError } from './toolHelpers';

const HEADER_FIELDS = {
  supplier_id: 'supplierId',
  invoice_number: 'invoiceNumber',
  invoice_date: 'invoiceDate',
  due_date: 'dueDate',
  payment_terms: 'paymentTerms',
  reference: 'reference',
  notes: 'notes',
} as const;

export const updateSupplierInvoiceTool: McpTool = {
  name: 'update_supplier_invoice',
  description:
    'Edit a DRAFT supplier invoice (bill). Posts nothing. Send only the fields to change; `lines`, when sent, '
    + 'REPLACES every line and the subtotal, VAT and total are recomputed exactly as create_supplier_invoice '
    + 'computes them (amounts NET of VAT; tax_rate defaults the lines\' rate and is accepted only with lines). '
    + 'Refused, with the reason, when: the bill is not a draft (approved bills: cancel_supplier_invoice, then '
    + 're-enter); a posted journal (e.g. DRC VAT) is sourced from it; the total, supplier or number would '
    + 'change while a payment, credit note, approval request or matched statement line names the bill, or '
    + 'the supplier already has a live bill with that number; or the '
    + 'stored lines carry a purchase-order link, project, cost centre or VAT classification that replacing '
    + 'them would drop. due_date is never re-derived from payment_terms — send it when the dates change.',
  scope: 'write:invoices',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      invoice_id: { type: 'string', description: 'The draft bill, from list_supplier_invoices.' },
      supplier_id: { type: 'string', description: 'Supplier UUID (from list_suppliers)' },
      invoice_number: { type: 'string', maxLength: TEXT_LIMITS.invoice_number },
      invoice_date: { type: 'string', format: 'date', description: 'YYYY-MM-DD' },
      due_date: { type: 'string', format: 'date', description: 'YYYY-MM-DD' },
      payment_terms: { type: 'string', maxLength: TEXT_LIMITS.payment_terms },
      reference: { type: 'string', maxLength: TEXT_LIMITS.reference },
      notes: { type: 'string' },
      tax_rate: { type: 'number', description: 'Default VAT % for the lines sent. Only with lines.' },
      lines: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_LINES,
        description: 'Replaces ALL lines.',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            quantity: { type: 'number', exclusiveMinimum: 0 },
            unit_price: { type: 'number', minimum: 0, description: 'NET of VAT' },
            tax_rate: { type: 'number', minimum: 0, maximum: 100 },
            gl_account_id: { type: 'string', description: 'Expense GL account UUID; defaults to the company default expense account' },
          },
          required: ['description', 'quantity', 'unit_price'],
          additionalProperties: false,
        },
      },
      idempotency_key: { type: 'string' },
    },
    required: ['invoice_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const invoiceId = strArg(args, 'invoice_id');
    if (!invoiceId) return toolError('invoice_id is required');
    const patch = parsePatch(args);
    if (typeof patch === 'string') return toolError(patch);

    // Planned on the LOCKED row, so no concurrent approve or allocation can
    // move what the plan decided before the apply writes.
    let plan: SupplierInvoiceDraftUpdatePlan;
    try {
      plan = await lockAndPlanSupplierInvoiceDraftUpdate(ctx.companyId, invoiceId, patch);
    } catch (err) {
      // Reads only: nothing has been written, so a refusal is safe to return.
      if (err instanceof SupplierInvoiceDraftUpdateRefusal) {
        return toolError(err.message === 'Not found' ? NOT_FOUND : err.message);
      }
      // The row lock is the plan's first statement, so a timeout on it is
      // write-free too — and its message says "retry", which GENERIC_FAILURE would not.
      if (err instanceof SupplierInvoiceLockTimeoutError) return toolError(err.message);
      throw err;
    }

    // No catch — see the header.
    await applySupplierInvoiceDraftUpdate(ctx.companyId, plan);
    const bill = await getSupplierInvoiceById(ctx.companyId, invoiceId);
    if (!bill) return toolError(NOT_FOUND);
    return ok({
      id: bill.id,
      invoice_number: bill.invoiceNumber,
      supplier_id: bill.supplierId,
      invoice_date: bill.invoiceDate,
      due_date: bill.dueDate ?? null,
      subtotal: bill.subtotal,
      tax_amount: bill.taxAmount,
      total_amount: bill.totalAmount,
      status: bill.status,
      changed: plan.changed,
      lines: bill.items.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unit_price: l.unitPrice,
        tax_rate: l.taxRate,
        tax_amount: l.taxAmount,
        line_total: l.lineTotal,
        gl_account_id: l.glAccountId ?? null,
      })),
    });
  },
};

/** Parse the patch before any read. Returns the refusal MESSAGE on failure. */
function parsePatch(args: Record<string, unknown>): SupplierInvoiceDraftPatch | string {
  const bad = castableArgError(args, {
    uuid: ['invoice_id', 'supplier_id'],
    date: ['invoice_date', 'due_date'],
  });
  if (bad) return bad;

  const patch: SupplierInvoiceDraftPatch = {};
  for (const [arg, key] of Object.entries(HEADER_FIELDS)) {
    const value = strArg(args, arg);
    if (value === undefined) continue;
    const max = (TEXT_LIMITS as Record<string, number>)[arg];
    if (max !== undefined && value.length > max) {
      return `${arg} is ${value.length} characters; the maximum is ${max}`;
    }
    patch[key] = value;
  }

  if (args.tax_rate !== undefined && args.tax_rate !== null) {
    const taxRate = Number(args.tax_rate);
    if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) {
      return 'tax_rate must be between 0 and 100';
    }
    patch.taxRate = taxRate;
  }
  if (args.lines !== undefined) {
    const parsed = parseSupplierLines(args.lines);
    if (typeof parsed === 'string') return parsed;
    patch.items = parsed.items;
  }

  if (Object.keys(patch).length === 0) {
    return 'Nothing to update: send at least one of supplier_id, invoice_number, invoice_date, '
      + 'due_date, payment_terms, reference, notes or lines.';
  }
  return patch;
}
