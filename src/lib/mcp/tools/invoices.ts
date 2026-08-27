/**
 * MCP read tools: customer invoices + quotes. The COALESCE(client_id,
 * customer_id) quirk lives in the shared read service, not here.
 */
import type { McpTool } from '../types';
import {
  getCustomerInvoiceDetail,
  listCustomerInvoices,
} from '@/modules/accounting/services/ar/customerInvoiceReadService';
import { getQuotes } from '@/modules/accounting/services/ar/quoteService';
import { NOT_FOUND, clampLimit, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

export const listInvoicesTool: McpTool = {
  name: 'list_invoices',
  description:
    'Customer invoices, newest first. Filter by status (draft/sent/paid/…), customer_id, or free-text search. Max 100 rows.',
  scope: 'read:invoices',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: 'Invoice status, or omit for all' },
      customer_id: { type: 'string' },
      search: { type: 'string', description: 'Matches invoice number or customer name' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    // status and search are compared as TEXT; customer_id is a UUID cast.
    const bad = guardCastableArgs(args, { uuid: ['customer_id'] });
    if (bad) return bad;
    const status = strArg(args, 'status');
    const result = await listCustomerInvoices(ctx.companyId, {
      status: status && status !== 'all' ? [status] : null,
      clientId: strArg(args, 'customer_id') ?? null,
      search: strArg(args, 'search') ?? null,
      limit: clampLimit(args, 25, 100),
    });
    return ok(result);
  },
};

export const getInvoiceTool: McpTool = {
  name: 'get_invoice',
  description: 'One customer invoice by id, including line items.',
  scope: 'read:invoices',
  write: false,
  inputSchema: {
    type: 'object',
    properties: { invoice_id: { type: 'string' } },
    required: ['invoice_id'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const invoiceId = strArg(args, 'invoice_id');
    if (!invoiceId) return toolError('invoice_id is required');
    const bad = guardCastableArgs(args, { uuid: ['invoice_id'] });
    if (bad) return bad;
    const invoice = await getCustomerInvoiceDetail(ctx.companyId, invoiceId);
    // Cross-tenant probes land here too — identical text to a genuine miss.
    if (!invoice) return toolError(NOT_FOUND);
    return ok(invoice);
  },
};

export const listQuotesTool: McpTool = {
  name: 'list_quotes',
  description: 'Customer quotes, newest first. Filter by status or search. Max 100 rows.',
  scope: 'read:invoices',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string' },
      search: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const result = await getQuotes(ctx.companyId, {
      status: strArg(args, 'status'),
      search: strArg(args, 'search'),
      limit: clampLimit(args, 50, 100),
    });
    return ok(result);
  },
};
