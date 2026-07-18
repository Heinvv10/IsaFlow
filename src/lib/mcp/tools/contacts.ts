/**
 * MCP read tools: customer + supplier directories. Directory reads only —
 * no balances (the routes do not return them either).
 */
import type { McpTool } from '../types';
import {
  listCustomers,
  listSuppliers,
} from '@/modules/accounting/services/core/contactDirectoryService';
import { clampLimit, ok, strArg } from './toolHelpers';

export const listCustomersTool: McpTool = {
  name: 'list_customers',
  description:
    'Customers of the connected company (name, contact details, payment terms, VAT number). Optional free-text search. Max 200 rows.',
  scope: 'read:contacts',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      search: { type: 'string', description: 'Matches name, email, VAT number, or contact person' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => ok(await listCustomers(ctx.companyId, strArg(args, 'search') ?? null)),
};

export const listSuppliersTool: McpTool = {
  name: 'list_suppliers',
  description:
    'Suppliers of the connected company (name, company, contact details, payment terms). Optional search. Max 200 rows.',
  scope: 'read:contacts',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      search: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) =>
    ok(
      await listSuppliers(ctx.companyId, {
        search: strArg(args, 'search') ?? null,
        limit: clampLimit(args, 25, 200),
      }),
    ),
};
