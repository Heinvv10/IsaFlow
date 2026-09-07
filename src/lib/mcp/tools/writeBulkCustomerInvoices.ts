/**
 * MCP write tool: create many DRAFT customer invoices in one call.
 *
 * Split from `writeBulkInvoices.ts` (the AP arm) when that file went over the
 * 300-line cap — two tools sharing a file was the natural seam.
 *
 * ALL OR NOTHING, and here that is the whole story: unlike the AP arm there is
 * no in-batch duplicate to skip, because this tool does not accept an invoice
 * number at all. It RESERVES one per element, so the caller cannot supply a
 * repeat and `uq_customer_invoices_company_number` is never the caller's to
 * trip. Every element is parsed and every id ownership-checked before the first
 * write; after that a failure PROPAGATES, so the registry's savepoint discards
 * the half-built batch rather than this handler returning a partial success.
 */
import type { McpTool } from '../types';
import {
  createDraftCustomerInvoice,
  InvoiceLineValidationError,
} from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { customerBelongsToCompany } from '@/modules/accounting/services/core/contactDirectoryService';
import { mcpPostingOpts } from '../mcpActor';
import {
  MAX_LINES,
  parseCustomerInvoiceInput,
  type ParsedCustomerInvoice,
} from './invoiceCreateArgs';
import { MAX_INVOICES, elementError, parseBatch } from './writeBulkInvoices';
import { NOT_FOUND, ok, toolError } from './toolHelpers';


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
