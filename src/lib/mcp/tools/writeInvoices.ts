/**
 * MCP write tools: customer invoices + quotes. Drafts create in draft/unposted
 * status; finalize_invoice transitions draft → approved and additionally
 * requires write:post. All call the same services the routes/UI use;
 * companyId + userId come from ctx ONLY.
 */
import type { McpTool } from '../types';
import {
  createDraftCustomerInvoice,
  InvoiceLineValidationError,
} from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import {
  approveCustomerInvoice,
  InvoiceNotApprovableError,
} from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { createQuote, LineValidationError } from '@/modules/accounting/services/ar/quoteService';
import { customerBelongsToCompany } from '@/modules/accounting/services/core/contactDirectoryService';
import { mcpPostingAgent } from '../postingAgent';
import { NOT_FOUND, ok, strArg, toolError } from './toolHelpers';

interface LineIn {
  description: string;
  quantity?: number;
  unitPrice: number;
}

function parseLines(raw: unknown): LineIn[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const lines: LineIn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const o = item as Record<string, unknown>;
    const description = typeof o.description === 'string' ? o.description : '';
    const unitPrice = Number(o.unit_price);
    if (!description || !Number.isFinite(unitPrice)) return null;
    const qtyRaw = o.quantity === undefined ? 1 : Number(o.quantity);
    if (!Number.isFinite(qtyRaw)) return null;
    lines.push({ description, unitPrice, quantity: qtyRaw });
  }
  return lines;
}

const LINE_ITEMS_SCHEMA = {
  type: 'array',
  minItems: 1,
  items: {
    type: 'object',
    properties: {
      description: { type: 'string' },
      quantity: { type: 'number', exclusiveMinimum: 0 },
      unit_price: { type: 'number', minimum: 0 },
    },
    required: ['description', 'unit_price'],
    additionalProperties: false,
  },
} as const;

export const createDraftInvoiceTool: McpTool = {
  name: 'create_draft_invoice',
  description:
    'Create a customer invoice in DRAFT status (an invoice number is reserved). Does not post to the GL or send — use finalize_invoice (needs write:post) to approve.',
  scope: 'write:invoices',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      customer_id: { type: 'string' },
      items: LINE_ITEMS_SCHEMA,
      invoice_date: { type: 'string', format: 'date' },
      due_date: { type: 'string', format: 'date' },
      tax_rate: { type: 'number', minimum: 0 },
      notes: { type: 'string' },
      idempotency_key: { type: 'string' },
    },
    required: ['customer_id', 'items', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const customerId = strArg(args, 'customer_id');
    if (!customerId) return toolError('customer_id is required');
    const items = parseLines(args.items);
    if (!items) return toolError('items must be a non-empty array of {description, unit_price, quantity?}');
    // Ownership: the customer must belong to the token's company (a plain FK
    // would otherwise accept any company's customer id). Generic error — no
    // existence oracle for foreign ids.
    if (!(await customerBelongsToCompany(ctx.companyId, customerId))) return toolError(NOT_FOUND);
    try {
      const result = await createDraftCustomerInvoice(ctx.companyId, ctx.userId, {
        clientId: customerId,
        items,
        invoiceDate: strArg(args, 'invoice_date'),
        dueDate: strArg(args, 'due_date'),
        taxRate: typeof args.tax_rate === 'number' ? args.tax_rate : undefined,
        notes: strArg(args, 'notes'),
      });
      return ok(result);
    } catch (err) {
      // Pre-write only. InvoiceLineValidationError is raised while validating
      // the lines, before the first INSERT, so nothing was written.
      //
      // Everything else must propagate. createDraftCustomerInvoice guards only
      // the invoice-number retry with a savepoint; the line items are inserted
      // OUTSIDE it, so a failing line leaves a committed invoice header with no
      // detail — an AR document carrying a total and nothing to justify it.
      // Swallowing that into toolError() means the handler returns normally,
      // the registry's write-tool savepoint RELEASES instead of rolling back,
      // and the transport's 200 makes bearerPipeline COMMIT the partial row.
      if (err instanceof InvoiceLineValidationError) return toolError(err.message);
      throw err;
    }
  },
};

export const createDraftQuoteTool: McpTool = {
  name: 'create_draft_quote',
  description: 'Create a customer quote in DRAFT status.',
  scope: 'write:invoices',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      customer_name: { type: 'string' },
      customer_id: { type: 'string', description: 'Optional existing customer UUID' },
      items: LINE_ITEMS_SCHEMA,
      quote_date: { type: 'string', format: 'date' },
      expiry_date: { type: 'string', format: 'date' },
      notes: { type: 'string' },
      idempotency_key: { type: 'string' },
    },
    required: ['customer_name', 'items', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const customerName = strArg(args, 'customer_name');
    if (!customerName) return toolError('customer_name is required');
    const items = parseLines(args.items);
    if (!items) return toolError('items must be a non-empty array of {description, unit_price, quantity?}');
    try {
      const quote = await createQuote(
        ctx.companyId,
        {
          customerName,
          clientId: strArg(args, 'customer_id'),
          quoteDate: strArg(args, 'quote_date'),
          expiryDate: strArg(args, 'expiry_date'),
          notes: strArg(args, 'notes'),
          lines: items.map((l) => ({
            description: l.description,
            quantity: l.quantity ?? 1,
            unitPrice: l.unitPrice,
          })),
        },
        ctx.userId,
      );
      return ok(quote);
    } catch (err) {
      // Pre-write only, same reasoning as create_draft_invoice above.
      // createQuote INSERTs the quote header and then loops the lines with no
      // transaction and no savepoint at all, so a failing line leaves a
      // committed header with partial lines unless this throw reaches the
      // registry's savepoint.
      if (err instanceof LineValidationError) return toolError(err.message);
      throw err;
    }
  },
};

export const finalizeInvoiceTool: McpTool = {
  name: 'finalize_invoice',
  description:
    'Approve a DRAFT customer invoice (draft → approved, posts it to the GL) — irreversible. Requires the write:post permission.',
  scope: 'write:invoices',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      invoice_id: { type: 'string' },
      idempotency_key: { type: 'string' },
    },
    required: ['invoice_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const invoiceId = strArg(args, 'invoice_id');
    if (!invoiceId) return toolError('invoice_id is required');
    try {
      // Approval POSTS the AR journal. Unstamped it lands as human:<userId> —
      // the agent's posting attributed to the token owner and missing from
      // list_agent_postings, the only surface that answers "what did the agent
      // do to my books?".
      const result = await approveCustomerInvoice(
        ctx.companyId,
        invoiceId,
        ctx.userId,
        { postingAgent: mcpPostingAgent('finalize_invoice') },
      );
      return ok(result);
    } catch (err) {
      // Only the pre-write guard may be turned into a tool error here.
      //
      // approveCustomerInvoice flips the invoice to 'approved' and THEN posts
      // the GL journal. Catching a post failure and returning toolError() means
      // the handler does not throw, so the registry's write-tool SAVEPOINT
      // (registry.ts) releases instead of rolling back, and the transport's 200
      // makes bearerPipeline COMMIT — leaving the invoice approved and in AR
      // with no journal behind it. That is exactly the AR/GL divergence
      // approveCustomerInvoice now throws to prevent, so the throw has to reach
      // the registry.
      //
      // InvoiceNotApprovableError is safe to report precisely: it is raised when
      // the guarded UPDATE matched zero rows, so nothing was written.
      if (err instanceof InvoiceNotApprovableError) return toolError(err.message);
      throw err;
    }
  },
};
