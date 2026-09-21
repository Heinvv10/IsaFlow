/**
 * MCP read tools: customer + supplier directories. Directory reads only —
 * no balances (the routes do not return them either).
 */
import type { McpTool } from '../types';
import {
  listCustomers,
  listSuppliers,
} from '@/modules/accounting/services/core/contactDirectoryService';
import { clampLimit, ok, strArg, toolError } from './toolHelpers';
import { OFFSET_SCHEMA, nextOffsetFromTotal, parseOffset } from './pageArgs';

export const listCustomersTool: McpTool = {
  name: 'list_customers',
  description:
    'Customers of the connected company (name, contact details, payment terms, VAT number), ordered by '
    + 'name. Optional free-text search. Returns {customers, next_offset}: up to `limit` rows (default and '
    + 'max 200); when next_offset is not null, call again with offset=next_offset for the next page.',
  scope: 'read:contacts',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      search: { type: 'string', description: 'Matches name, email, VAT number, or contact person' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      offset: OFFSET_SCHEMA,
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const offset = parseOffset(args);
    if (typeof offset === 'string') return toolError(offset);
    const limit = clampLimit(args, 200, 200);
    // One row past the page: its presence is what says another page exists,
    // without a second COUNT query.
    const rows = await listCustomers(ctx.companyId, strArg(args, 'search') ?? null, {
      limit: limit + 1,
      offset,
    });
    return ok({
      customers: rows.slice(0, limit),
      next_offset: rows.length > limit ? offset + limit : null,
    });
  },
};

export const listSuppliersTool: McpTool = {
  name: 'list_suppliers',
  description:
    'Suppliers of the connected company (name, company, contact details, payment terms), ordered by name. '
    + 'Optional search. Returns {suppliers, total, next_offset}: up to `limit` rows (default 25, max 200); '
    + 'when next_offset is not null, call again with offset=next_offset for the next page.',
  scope: 'read:contacts',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      search: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      offset: OFFSET_SCHEMA,
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const offset = parseOffset(args);
    if (typeof offset === 'string') return toolError(offset);
    const result = await listSuppliers(ctx.companyId, {
      search: strArg(args, 'search') ?? null,
      limit: clampLimit(args, 25, 200),
      offset,
    });
    return ok({
      ...result,
      next_offset: nextOffsetFromTotal(offset, result.suppliers.length, result.total),
    });
  },
};
