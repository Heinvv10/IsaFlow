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
 * with nothing written; once writing starts a failure PROPAGATES, putting the
 * registry's savepoint in charge of discarding the half-built batch. A bulk
 * create that committed 60 of 100 bills and reported an error would leave an
 * agent unable to tell which 40 to retry, and a retry would double-post the 60.
 *
 * A REPEATED ELEMENT IS NOT A FAULT — it is one bill sent twice, so it is
 * skipped and the rest of the batch runs. That decision, and why it is only
 * safe because it is taken before the first INSERT, lives in
 * `bulkInvoiceDuplicateSkip.ts`.
 *
 * There is no books-level duplicate check, deliberately: `supplier_invoices`
 * carries NO unique index on `invoice_number` (only the primary key) and
 * `idx_supplier_invoices_duplicate_fp` is explicitly not unique, so the
 * database accepts the same number twice and refusing it here would be a rule
 * this tool invented.
 */
import type { McpTool } from '../types';
import { createSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceService';
import { supplierBelongsToCompany } from '@/modules/accounting/services/core/contactDirectoryService';
import { accountsBelongToCompany } from '@/modules/accounting/services/gl/chartOfAccountsService';
import { mcpPostingOpts } from '../mcpActor';
import { MAX_LINES } from './invoiceCreateArgs';
import { partitionSupplierInvoiceBatch } from './bulkInvoiceDuplicateSkip';
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
export function parseBatch(raw: unknown): Record<string, unknown>[] | string {
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



/**
 * Name the failing element without destroying the error.
 *
 * `registry.ts` dispatches on typed errors (`MissingSystemAccountError`,
 * `BulkAllocationLineError`) to turn an unactionable GENERIC_FAILURE into a
 * message naming what to fix. Wrapping in a bare `new Error` threw that class
 * away, so a bulk create against a chart missing a system account came back as
 * "please try again" — advice that cannot work, the chart being identical on
 * the retry. Typed errors pass through; only an untyped one is wrapped, keeping
 * the original as `cause`.
 */
export function elementError(index: number, err: unknown, fallback: string): unknown {
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

    // Repeats are set aside here, before any write — see
    // bulkInvoiceDuplicateSkip.ts for why that is a skip and not a refusal, and
    // why doing it any later would be unsafe.
    const partitioned = partitionSupplierInvoiceBatch(batch);
    if (typeof partitioned === 'string') return toolError(partitioned);
    const { kept, skipped, supplierIds, accountIds } = partitioned;

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
    for (const { index, inv: p } of kept) {
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
