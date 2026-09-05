/**
 * MCP write tools: create many invoices in one call.
 *
 * Reloading a subledger is the case these exist for — Velocity Fibre's AR/AP
 * rebuild is ~85 customer invoices and ~2,200 bills, and one round trip each is
 * workable but slow. The payload of each element is EXACTLY what
 * `create_supplier_invoice` / `create_draft_invoice` take, minus the per-call
 * `idempotency_key`, so an agent that has learned the single tool needs to
 * learn nothing new.
 *
 * ALL OR NOTHING, deliberately. Every element is parsed and every id is
 * ownership-checked before the first INSERT, so a malformed batch is refused
 * with nothing written; and once writing starts a failure PROPAGATES, which
 * puts the registry's savepoint — not this handler — in charge of discarding
 * the half-built batch. A bulk create that committed the first 60 of 100 bills
 * and reported an error would leave an agent unable to tell which 40 to retry,
 * and retrying the whole batch would double-post the 60.
 */
import type { McpTool } from '../types';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import {
  createDraftCustomerInvoice,
  InvoiceLineValidationError,
} from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { supplierBelongsToCompany, customerBelongsToCompany } from '@/modules/accounting/services/core/contactDirectoryService';
import { accountsBelongToCompany } from '@/modules/accounting/services/gl/chartOfAccountsService';
import { mcpPostingOpts } from '../mcpActor';
import {
  MAX_LINES,
  parseCustomerInvoiceInput,
  parseSupplierInvoiceInput,
  type ParsedCustomerInvoice,
  type ParsedSupplierInvoice,
} from './invoiceCreateArgs';
import { NOT_FOUND, ok, safeErrorText, toolError } from './toolHelpers';
import { MissingSystemAccountError } from '@/modules/accounting/services/gl/systemAccountKeys';

/**
 * More invoices than this in one call is a mistake, not a batch.
 *
 * The whole batch shares one savepoint and one request, so the ceiling is about
 * how much work a single rollback should be able to throw away, not about how
 * many an agent can hold. 2,200 bills is 22 calls at this size.
 */
export const MAX_INVOICES = 100;

/** Pull `args.invoices` out as a list of records, or return the refusal. */
function parseBatch(raw: unknown): Record<string, unknown>[] | string {
  if (!Array.isArray(raw) || raw.length === 0) {
    return 'invoices must be a non-empty array';
  }
  if (raw.length > MAX_INVOICES) {
    return `invoices has ${raw.length} elements; the maximum is ${MAX_INVOICES}. `
      + 'Split it across several calls.';
  }
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return `invoices[${i}] must be an object`;
    }
    out.push(item as Record<string, unknown>);
  }
  return out;
}

const SUPPLIER_LINE_SCHEMA = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    quantity: { type: 'number', exclusiveMinimum: 0 },
    unit_price: { type: 'number', minimum: 0, description: 'NET of VAT' },
    tax_rate: { type: 'number', minimum: 0, maximum: 100 },
    gl_account_id: { type: 'string', description: 'Expense GL account UUID' },
  },
  required: ['description', 'quantity', 'unit_price'],
  additionalProperties: false,
} as const;

const CUSTOMER_LINE_SCHEMA = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    quantity: { type: 'number', exclusiveMinimum: 0 },
    unit_price: { type: 'number', minimum: 0 },
  },
  required: ['description', 'unit_price'],
  additionalProperties: false,
} as const;


/**
 * Name the failing element without destroying the error.
 *
 * `registry.ts` dispatches on `instanceof MissingSystemAccountError` (and
 * `BulkAllocationLineError`) to turn an unactionable GENERIC_FAILURE into a
 * message naming what to fix. Wrapping in a bare `new Error` threw that class
 * away, so a bulk create against a chart missing a system account came back as
 * "please try again" — advice that cannot work, the chart being the same on the
 * retry. Typed errors pass through untouched; only an untyped one is wrapped,
 * and it keeps the original as `cause`.
 */
function elementError(index: number, err: unknown, fallback: string): unknown {
  if (err instanceof MissingSystemAccountError) return err;
  return new Error(`invoices[${index}]: ${safeErrorText(err, fallback)}`, { cause: err });
}

export const bulkCreateSupplierInvoicesTool: McpTool = {
  name: 'bulk_create_supplier_invoices',
  description:
    'Create up to 100 DRAFT supplier invoices (bills) in ONE call. Each element takes the same payload as create_supplier_invoice, without its idempotency_key. '
    + 'Posts nothing to the ledger — approve each with approve_supplier_invoice (needs write:post). '
    + 'ALL OR NOTHING: if any element is rejected or fails, none of them are created, so a retry on the same idempotency_key is safe. '
    + 'Resolve supplier_id with list_suppliers and gl_account_id with list_gl_accounts first.',
  scope: 'write:invoices',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      invoices: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_INVOICES,
        items: {
          type: 'object',
          properties: {
            supplier_id: { type: 'string', description: 'Supplier UUID (from list_suppliers)' },
            invoice_number: { type: 'string', description: "The supplier's own invoice number" },
            invoice_date: { type: 'string', format: 'date', description: 'YYYY-MM-DD' },
            due_date: { type: 'string', format: 'date' },
            tax_rate: { type: 'number', description: 'Invoice-level VAT %, default 15' },
            payment_terms: { type: 'string' },
            reference: { type: 'string' },
            notes: { type: 'string' },
            lines: {
              type: 'array', minItems: 1, maxItems: MAX_LINES, items: SUPPLIER_LINE_SCHEMA,
            },
          },
          required: ['supplier_id', 'invoice_number', 'invoice_date', 'lines'],
          additionalProperties: false,
        },
      },
      idempotency_key: { type: 'string' },
    },
    required: ['invoices', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const batch = parseBatch(args.invoices);
    if (typeof batch === 'string') return toolError(batch);

    const parsed: ParsedSupplierInvoice[] = [];
    const supplierIds = new Set<string>();
    const accountIds = new Set<string>();
    // (supplier, their own invoice number) twice in one batch is a duplicated
    // element, not two bills: a supplier does not issue one number twice. It is
    // caught here because the AP service has no such constraint and would
    // cheerfully create both.
    const seen = new Set<string>();
    for (let i = 0; i < batch.length; i++) {
      const one = parseSupplierInvoiceInput(batch[i]!);
      if (typeof one === 'string') return toolError(`invoices[${i}].${one}`);
      const key = `${one.supplierId} ${one.invoiceNumber}`;
      if (seen.has(key)) {
        return toolError(
          `invoices[${i}] repeats invoice_number ${JSON.stringify(one.invoiceNumber)} `
          + 'for the same supplier — combine the lines',
        );
      }
      seen.add(key);
      supplierIds.add(one.supplierId);
      for (const id of one.accountIds) accountIds.add(id);
      parsed.push(one);
    }

    // Ownership for the WHOLE batch, before the first write, over the DISTINCT
    // ids rather than one pair of queries per element. NOT_FOUND rather than
    // naming the element: a reply that says which id was foreign is an
    // existence oracle.
    for (const supplierId of supplierIds) {
      if (!(await supplierBelongsToCompany(ctx.companyId, supplierId))) return toolError(NOT_FOUND);
    }
    if (accountIds.size > 0
        && !(await accountsBelongToCompany(ctx.companyId, [...accountIds]))) {
      return toolError('One or more lines[].gl_account_id values are not GL accounts in your company.');
    }

    const created: Record<string, unknown>[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const p = parsed[i]!;
      try {
        const invoice = await createSupplierInvoice(
          ctx.companyId,
          {
            supplierId: p.supplierId,
            invoiceNumber: p.invoiceNumber,
            invoiceDate: p.invoiceDate,
            dueDate: p.dueDate,
            taxRate: p.taxRate,
            paymentTerms: p.paymentTerms,
            reference: p.reference,
            notes: p.notes,
            items: p.items,
          },
          ctx.userId,
          mcpPostingOpts(ctx, 'bulk_create_supplier_invoices'),
        );
        created.push({
          index: i,
          id: invoice.id,
          invoice_number: invoice.invoiceNumber,
          supplier_id: invoice.supplierId,
          invoice_date: invoice.invoiceDate,
          total_amount: invoice.totalAmount,
          status: invoice.status,
        });
      } catch (err) {
        // THROW, never toolError. The service validates a line before its own
        // INSERT, so this element wrote nothing — but the elements above it
        // did. Only a throw reaches the registry's savepoint and discards them;
        // a returned error RELEASES the savepoint and commits the partial run.
        throw elementError(i, err, 'Failed to create supplier invoice.');
      }
    }

    return ok({ created_count: created.length, invoices: created });
  },
};

export const bulkCreateCustomerInvoicesTool: McpTool = {
  name: 'bulk_create_customer_invoices',
  description:
    'Create up to 100 DRAFT customer invoices in ONE call. Each element takes the same payload as create_draft_invoice, without its idempotency_key. '
    + 'Reserves an invoice number for each; posts nothing to the GL — approve each with finalize_invoice (needs write:post). '
    + 'ALL OR NOTHING: if any element is rejected or fails, none of them are created, so a retry on the same idempotency_key is safe.',
  scope: 'write:invoices',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      invoices: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_INVOICES,
        items: {
          type: 'object',
          properties: {
            customer_id: { type: 'string' },
            items: {
              type: 'array', minItems: 1, maxItems: MAX_LINES, items: CUSTOMER_LINE_SCHEMA,
            },
            invoice_date: { type: 'string', format: 'date' },
            due_date: { type: 'string', format: 'date' },
            tax_rate: { type: 'number', minimum: 0 },
            notes: { type: 'string' },
          },
          required: ['customer_id', 'items'],
          additionalProperties: false,
        },
      },
      idempotency_key: { type: 'string' },
    },
    required: ['invoices', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const batch = parseBatch(args.invoices);
    if (typeof batch === 'string') return toolError(batch);

    const parsed: ParsedCustomerInvoice[] = [];
    const customerIds = new Set<string>();
    for (let i = 0; i < batch.length; i++) {
      const one = parseCustomerInvoiceInput(batch[i]!);
      if (typeof one === 'string') return toolError(`invoices[${i}].${one}`);
      customerIds.add(one.customerId);
      parsed.push(one);
    }

    for (const customerId of customerIds) {
      if (!(await customerBelongsToCompany(ctx.companyId, customerId))) return toolError(NOT_FOUND);
    }

    const created: Record<string, unknown>[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const p = parsed[i]!;
      try {
        const result = await createDraftCustomerInvoice(ctx.companyId, ctx.userId, {
          clientId: p.customerId,
          items: p.items,
          invoiceDate: p.invoiceDate,
          dueDate: p.dueDate,
          taxRate: p.taxRate,
          notes: p.notes,
        }, mcpPostingOpts(ctx, 'bulk_create_customer_invoices'));
        created.push({ index: i, ...(result as unknown as Record<string, unknown>) });
      } catch (err) {
        // Same reasoning as the AP arm above: rethrow so the savepoint discards
        // every element, including the ones already committed.
        if (err instanceof InvoiceLineValidationError) {
          throw new Error(`invoices[${i}]: ${err.message}`, { cause: err });
        }
        throw elementError(i, err, 'Failed to create customer invoice.');
      }
    }

    return ok({ created_count: created.length, invoices: created });
  },
};
