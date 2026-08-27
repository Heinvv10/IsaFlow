/**
 * MCP read tools: bank accounts + transactions. Calls the same services the
 * bank routes use; the transaction service caps rows at 100 internally
 * (plan said 200 — service reality wins, noted in the PR).
 */
import type { McpTool } from '../types';
import { getBankAccountsStatus } from '@/modules/accounting/services/bank/bankAccountStatusService';
import { getBankTransactions } from '@/modules/accounting/services/bank/bankTransactionQueryService';
import { clampLimit, ok, strArg } from './toolHelpers';

const ALLOCATION_FILTERS = ['all', 'unallocated', 'suggested', 'allocated'] as const;
type AllocationFilter = (typeof ALLOCATION_FILTERS)[number];

export const bankAccountsStatusTool: McpTool = {
  name: 'bank_accounts_status',
  description:
    'All active bank accounts with balances, reconciled/unreconciled amounts, and allocation counts.',
  scope: 'read:bank-tx',
  write: false,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => ok(await getBankAccountsStatus(ctx.companyId)),
};

export const listBankTransactionsTool: McpTool = {
  name: 'list_bank_transactions',
  description:
    'Bank transactions, filterable by account, allocation state, and date range. Max 100 rows. allocation_filter: allocated = a journal has been posted; suggested = categorised/AI-suggested but not yet posted; unallocated = neither.',
  scope: 'read:bank-tx',
  write: false,
  inputSchema: {
    type: 'object',
    properties: {
      bank_account_id: { type: 'string' },
      allocation_filter: { type: 'string', enum: [...ALLOCATION_FILTERS] },
      from_date: { type: 'string', format: 'date' },
      to_date: { type: 'string', format: 'date' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const rawAlloc = strArg(args, 'allocation_filter');
    const allocationFilter: AllocationFilter | undefined = ALLOCATION_FILTERS.includes(
      rawAlloc as AllocationFilter,
    )
      ? (rawAlloc as AllocationFilter)
      : undefined;
    const result = await getBankTransactions(ctx.companyId, {
      bankAccountId: strArg(args, 'bank_account_id'),
      allocationFilter,
      fromDate: strArg(args, 'from_date'),
      toDate: strArg(args, 'to_date'),
      limit: clampLimit(args, 50, 100),
    });
    return ok(result);
  },
};
