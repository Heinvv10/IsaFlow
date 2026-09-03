/**
 * MCP write tools: supplier invoices (AP).
 *
 * The connector had no AP write path at all — `create_draft_invoice` /
 * `finalize_invoice` are sales-side. Payables could only be forced in as
 * journals, which bypasses the supplier subledger entirely: `aged_creditors`
 * stays empty, nothing ages, and no payment can ever match to the document.
 *
 * `create_supplier_invoice` posts nothing (status stays `draft`), so it is
 * `write` but not `requiresPost`. `approve_supplier_invoice` is the AP mirror
 * of `finalize_invoice`: it posts DR Expense + DR VAT Input / CR AP to the
 * ledger and is irreversible, so it additionally requires `write:post`.
 */
import type { McpTool } from '../types';
import {
  createSupplierInvoice,
  getSupplierInvoiceById,
} from '@/modules/accounting/services/ap/supplierInvoiceService';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { supplierBelongsToCompany } from '@/modules/accounting/services/core/contactDirectoryService';
import { accountsBelongToCompany } from '@/modules/accounting/services/gl/chartOfAccountsService';
import type { SupplierInvoiceItemInput } from '@/modules/accounting/types/ap.types';
import { UUID_RE } from '@/lib/validation';
import { mcpPostingOpts } from '../mcpActor';
import {
  NOT_FOUND,
  guardCastableArgs,
  ok,
  safeErrorText,
  strArg,
  toolError,
} from './toolHelpers';

const MAX_LINES = 200;

interface ParsedLines {
  items: SupplierInvoiceItemInput[];
  accountIds: string[];
}

/**
 * Parse and validate every line BEFORE any ownership query or write.
 *
 * The service rejects a non-positive quantity or a negative unit price, but it
 * does so after opening its transaction — refusing here means the whole call
 * is still pre-write, so a `toolError` leaves nothing behind and the agent
 * gets the offending line INDEX rather than a message it has to bisect a
 * 200-line bill to locate.
 */
function parseLines(raw: unknown): ParsedLines | string {
  if (!Array.isArray(raw) || raw.length === 0) {
    return 'lines must be a non-empty array of {description, quantity, unit_price}';
  }
  if (raw.length > MAX_LINES) {
    return `too many lines (${raw.length}); the maximum is ${MAX_LINES}`;
  }

  const items: SupplierInvoiceItemInput[] = [];
  const accountIds: string[] = [];

  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object') return `lines[${i}] must be an object`;
    const o = item as Record<string, unknown>;

    const description = typeof o.description === 'string' ? o.description.trim() : '';
    if (!description) return `lines[${i}].description is required`;

    const quantity = Number(o.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return `lines[${i}].quantity must be a positive number`;
    }
    const unitPrice = Number(o.unit_price);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      return `lines[${i}].unit_price must be a number and cannot be negative`;
    }

    let taxRate: number | undefined;
    if (o.tax_rate !== undefined && o.tax_rate !== null) {
      taxRate = Number(o.tax_rate);
      if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) {
        return `lines[${i}].tax_rate must be between 0 and 100`;
      }
    }

    let glAccountId: string | undefined;
    if (o.gl_account_id !== undefined && o.gl_account_id !== null) {
      if (typeof o.gl_account_id !== 'string' || !UUID_RE.test(o.gl_account_id)) {
        return `invalid lines[${i}].gl_account_id`;
      }
      glAccountId = o.gl_account_id;
      accountIds.push(glAccountId);
    }

    items.push({ description, quantity, unitPrice, taxRate, glAccountId });
  }

  return { items, accountIds };
}

export const createSupplierInvoiceTool: McpTool = {
  name: 'create_supplier_invoice',
  description:
    'Create a DRAFT supplier invoice (bill / accounts payable document). Posts nothing to the ledger — use approve_supplier_invoice (needs write:post) to post DR Expense + DR VAT Input / CR Accounts Payable. ' +
    'Line amounts are NET of VAT: tax_rate is applied on top of quantity x unit_price. A line with no gl_account_id posts to the company\'s default expense account. ' +
    'Resolve supplier_id with list_suppliers and gl_account_id with list_gl_accounts first.',
  scope: 'write:invoices',
  write: true,
  inputSchema: {
    type: 'object',
    properties: {
      supplier_id: { type: 'string', description: 'Supplier UUID (from list_suppliers)' },
      invoice_number: { type: 'string', description: "The supplier's own invoice number" },
      invoice_date: { type: 'string', format: 'date', description: 'YYYY-MM-DD' },
      due_date: { type: 'string', format: 'date', description: 'Defaults from payment_terms when omitted' },
      tax_rate: { type: 'number', description: 'Invoice-level VAT %, default 15. Per-line tax_rate overrides it.' },
      payment_terms: { type: 'string' },
      reference: { type: 'string' },
      notes: { type: 'string' },
      lines: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_LINES,
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
    required: ['supplier_id', 'invoice_number', 'invoice_date', 'lines', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const supplierId = strArg(args, 'supplier_id');
    const invoiceNumber = strArg(args, 'invoice_number');
    const invoiceDate = strArg(args, 'invoice_date');
    if (!supplierId) return toolError('supplier_id is required');
    if (!invoiceNumber) return toolError('invoice_number is required');
    if (!invoiceDate) return toolError('invoice_date is required (YYYY-MM-DD)');

    const bad = guardCastableArgs(args, {
      uuid: ['supplier_id'],
      date: ['invoice_date', 'due_date'],
    });
    if (bad) return bad;

    let taxRate: number | undefined;
    if (args.tax_rate !== undefined && args.tax_rate !== null) {
      taxRate = Number(args.tax_rate);
      if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) {
        return toolError('tax_rate must be between 0 and 100');
      }
    }

    const parsed = parseLines(args.lines);
    if (typeof parsed === 'string') return toolError(parsed);

    // Ownership, batched, before the first write. Neither the service nor the
    // database re-checks the tenant — supplier_id and gl_account_id become
    // plain foreign keys with no composite (id, company_id) constraint — so
    // this is the only thing standing between a foreign id and a cross-tenant
    // document. NOT_FOUND for both: a distinct "belongs to another company"
    // reply is an existence oracle.
    if (!(await supplierBelongsToCompany(ctx.companyId, supplierId))) {
      return toolError(NOT_FOUND);
    }
    if (parsed.accountIds.length > 0 &&
        !(await accountsBelongToCompany(ctx.companyId, parsed.accountIds))) {
      return toolError('One or more lines[].gl_account_id values are not GL accounts in your company.');
    }

    try {
      const invoice = await createSupplierInvoice(
        ctx.companyId,
        {
          supplierId,
          invoiceNumber,
          invoiceDate,
          dueDate: strArg(args, 'due_date'),
          taxRate,
          paymentTerms: strArg(args, 'payment_terms'),
          reference: strArg(args, 'reference'),
          notes: strArg(args, 'notes'),
          items: parsed.items,
        },
        ctx.userId,
        mcpPostingOpts(ctx, 'create_supplier_invoice'),
      );
      return ok({
        id: invoice.id,
        invoice_number: invoice.invoiceNumber,
        supplier_id: invoice.supplierId,
        invoice_date: invoice.invoiceDate,
        due_date: invoice.dueDate ?? null,
        subtotal: invoice.subtotal,
        tax_amount: invoice.taxAmount,
        total_amount: invoice.totalAmount,
        status: invoice.status,
      });
    } catch (err) {
      // The service's own validation (quantity, unit price) fires before its
      // INSERT, so surfacing the message keeps nothing written. Anything with
      // a SQLSTATE generic-ifies rather than leaking schema.
      return toolError(safeErrorText(err, 'Failed to create supplier invoice.'));
    }
  },
};

export const approveSupplierInvoiceTool: McpTool = {
  name: 'approve_supplier_invoice',
  description:
    'Approve a DRAFT supplier invoice and POST it to the ledger — DR Expense (per line) + DR VAT Input / CR Accounts Payable. Irreversible except by a reversing entry. Requires the write:post permission. ' +
    'The invoice must be in draft or pending_approval; anything else is refused with its current status.',
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
    const bad = guardCastableArgs(args, { uuid: ['invoice_id'] });
    if (bad) return bad;

    // Both refusals are answered from a READ so the service call below needs
    // no catch. approveSupplierInvoice raises the status one itself, but a
    // `catch -> toolError` cannot tell it from a failure after the journal was
    // posted — and a refusal is audited with a NULL idempotency key, so the
    // agent's retry on that key would post the invoice a second time.
    const invoice = await getSupplierInvoiceById(ctx.companyId, invoiceId);
    if (!invoice) return toolError(NOT_FOUND);
    if (invoice.status !== 'draft' && invoice.status !== 'pending_approval') {
      return toolError(`Cannot approve invoice with status: ${invoice.status}`);
    }

    // No catch: a missing system account, a closed period or a database
    // failure must reach the registry's savepoint rather than being flattened
    // into a tool error that keeps a partially posted journal.
    //
    // The stamp is what puts this entry in list_agent_postings. Without it
    // createJournalEntry falls back to defaultHumanMeta(userId), labelling
    // agent work as the token owner's own.
    const updated = await approveSupplierInvoice(ctx.companyId, invoiceId, ctx.userId, {
      ...mcpPostingOpts(ctx, 'approve_supplier_invoice'),
    });

    return ok({
      id: updated.id,
      invoice_number: updated.invoiceNumber,
      status: updated.status,
      total_amount: updated.totalAmount,
      gl_journal_entry_id: updated.glJournalEntryId ?? null,
    });
  },
};
