/**
 * MCP read tools: bank accounts + transactions. Calls the same services the
 * bank routes use; the transaction service caps rows at 100 internally
 * (plan said 200 — service reality wins, noted in the PR).
 */
import type { McpTool } from '../types';
import type { BankTransaction } from '@/modules/accounting/types/bank.types';
import { getBankAccountsStatus } from '@/modules/accounting/services/bank/bankAccountStatusService';
import { getBankTransactions } from '@/modules/accounting/services/bank/bankTransactionQueryService';
import { InvalidCursorError } from '@/modules/accounting/services/bank/bankTxCursor';
import { clampLimit, ok, strArg, toolError } from './toolHelpers';

const ALLOCATION_FILTERS = ['all', 'unallocated', 'suggested', 'allocated'] as const;
type AllocationFilter = (typeof ALLOCATION_FILTERS)[number];

type AllocationState = 'allocated' | 'suggested' | 'unallocated';

interface CompactBankTx {
  id: string;
  date: string;
  amount: number;
  bank_reference: string | null;
  allocation: AllocationState;
}

/** Same three-way split as `allocation_filter` (PRD-11 §2): a posted journal
 *  line is the ONLY thing that makes a row allocated; a suggestion is not. */
export function allocationStateOf(tx: BankTransaction): AllocationState {
  if (tx.matchedJournalLineId) return 'allocated';
  if (
    tx.suggestedGlAccountId || tx.suggestedSupplierId || tx.suggestedClientId || tx.allocationType
  ) {
    return 'suggested';
  }
  return 'unallocated';
}

function toCompact(tx: BankTransaction): CompactBankTx {
  return {
    id: tx.id,
    date: tx.transactionDate,
    amount: tx.amount,
    bank_reference: tx.bankReference ?? null,
    allocation: allocationStateOf(tx),
  };
}

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
    'Bank transactions, filterable by account, allocation state, and date range. Max 100 rows per call. ' +
    'allocation_filter: allocated = a journal has been posted; suggested = categorised/AI-suggested but not yet posted; unallocated = neither. ' +
    'Paging: the reply carries next_cursor whenever more rows match. To read a whole account, call again with cursor set to that value and every other argument unchanged, and keep looping until next_cursor is null. ' +
    'fields="compact" returns only id, date, amount, bank_reference and allocation (~10x smaller) — use it when you are scanning or bulk-allocating and do not need the full row.',
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
      cursor: { type: 'string', description: 'next_cursor from the previous page.' },
      fields: { type: 'string', enum: ['full', 'compact'] },
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
    const compact = strArg(args, 'fields') === 'compact';
    try {
      const result = await getBankTransactions(ctx.companyId, {
        bankAccountId: strArg(args, 'bank_account_id'),
        allocationFilter,
        fromDate: strArg(args, 'from_date'),
        toDate: strArg(args, 'to_date'),
        limit: clampLimit(args, 50, 100),
        cursor: strArg(args, 'cursor'),
      });
      return ok({
        transactions: compact ? result.transactions.map(toCompact) : result.transactions,
        total: result.total,
        next_cursor: result.nextCursor ?? null,
      });
    } catch (err) {
      if (err instanceof InvalidCursorError) return toolError('invalid cursor');
      throw err;
    }
  },
};
