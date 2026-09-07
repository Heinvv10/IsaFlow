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
 * ALL OR NOTHING for FAULTS, deliberately. Every element is parsed and every id
 * is ownership-checked before the first INSERT, so a malformed batch is refused
 * with nothing written; and once writing starts a failure PROPAGATES, which
 * puts the registry's savepoint — not this handler — in charge of discarding
 * the half-built batch. A bulk create that committed the first 60 of 100 bills
 * and reported an error would leave an agent unable to tell which 40 to retry,
 * and retrying the whole batch would double-post the 60.
 *
 * A REPEATED ELEMENT IS NOT A FAULT. Two elements carrying the same
 * (supplier_id, invoice_number) are one bill sent twice, and refusing the whole
 * call over it cost the Velocity Fibre reload real work: the Sage export held
 * 14 such pairs, so batches failed until every one had been found and
 * renumbered by hand — the bisect-it-yourself labour this tool exists to
 * remove. `bulk_allocate_bank_transactions` already draws the line correctly: a
 * fact about the DATA is a skip with a reason and the rest of the batch runs.
 *
 * The skip is safe here for a reason that does NOT generalise to a mid-write
 * one: it is decided in the PARSE pass, before the first INSERT, so an element
 * set aside has written nothing and the handler still returns normally. A skip
 * taken after writing had begun would release the registry's savepoint and
 * commit a partial batch under a success-shaped reply.
 *
 * There is no books-level duplicate check, and that is deliberate too.
 * `supplier_invoices` carries no unique index on `invoice_number` — only the
 * primary key — and `idx_supplier_invoices_duplicate_fp` is explicitly NOT
 * unique. The database accepts the same number twice, so refusing it here would
 * be a rule this tool invented. In-batch repeats are the only duplicates that
 * are unambiguously duplicates.
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
    + 'ALL OR NOTHING for faults: if an element genuinely fails, none of them are created, so a retry on the same idempotency_key is safe. '
    + 'A REPEAT IS NOT A FAULT: two elements with the same (supplier_id, invoice_number) are one bill sent twice — the first is created, the later ones are listed in "skipped" with a reason, and the rest of the batch still runs. '
    + 'Note this is an in-batch check only: the database accepts the same invoice_number twice, so a bill already in the books is NOT detected here. '
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

    // The caller's own index rides with each element: once repeats are set
    // aside, a position in `parsed` no longer matches a position in the
    // payload, and `created[].index` is what an agent reconciles against its
    // own list.
    const parsed: { index: number; inv: ParsedSupplierInvoice }[] = [];
    const skipped: Record<string, unknown>[] = [];
    const supplierIds = new Set<string>();
    const accountIds = new Set<string>();
    // (supplier, their own invoice number) twice in one batch is a duplicated
    // element, not two bills: a supplier does not issue one number twice. The
    // AP service has no such constraint and would cheerfully create both.
    //
    // The FIRST occurrence is kept and later ones are skipped — the caller's
    // order is the only thing distinguishing them, so anything else would be a
    // coin toss over which copy is real. The key is the PAIR: two suppliers may
    // each issue their own INV-1, and collapsing those would silently drop a
    // genuine bill, which is a worse failure than the one being fixed.
    const seenAt = new Map<string, number>();
    for (let i = 0; i < batch.length; i++) {
      const one = parseSupplierInvoiceInput(batch[i]!);
      // A malformed element is still a REFUSAL: it is a fault in the request,
      // not a fact about the data, and the caller cannot act on a batch that
      // half-ran because one payload was the wrong shape.
      if (typeof one === 'string') return toolError(`invoices[${i}].${one}`);
      const key = `${one.supplierId} ${one.invoiceNumber}`;
      const firstAt = seenAt.get(key);
      if (firstAt !== undefined) {
        skipped.push({
          index: i,
          invoice_number: one.invoiceNumber,
          supplier_id: one.supplierId,
          reason: `invoices[${firstAt}] already carries invoice_number `
            + `${JSON.stringify(one.invoiceNumber)} for this supplier — `
            + 'a supplier does not issue one number twice, so this element was '
            + 'not created. Combine the lines if they belong on one bill.',
        });
        continue;
      }
      seenAt.set(key, i);
      supplierIds.add(one.supplierId);
      for (const id of one.accountIds) accountIds.add(id);
      parsed.push({ index: i, inv: one });
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
    for (const { index, inv: p } of parsed) {
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
          index,
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
        throw elementError(index, err, 'Failed to create supplier invoice.');
      }
    }

    return ok({
      created_count: created.length,
      skipped_count: skipped.length,
      invoices: created,
      skipped,
    });
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
