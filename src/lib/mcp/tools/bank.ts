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
import { clampLimit, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

const ALLOCATION_FILTERS = ['all', 'unallocated', 'suggested', 'allocated'] as const;
type AllocationFilter = (typeof ALLOCATION_FILTERS)[number];

type AllocationState = 'allocated' | 'suggested' | 'unallocated' | 'excluded';

interface CompactBankTx {
  id: string;
  date: string;
  amount: number;
  bank_reference: string | null;
  allocation: AllocationState;
}

/**
 * Mirrors `allocation_filter` (PRD-11 §2), which is why `status` is part of it:
 * the SQL for both `suggested` and `unallocated` carries `AND bt.status != 'excluded'`,
 * so an excluded row is returned by NEITHER filter. Labelling it `unallocated`
 * would tell an agent to go allocate a row that `allocation_filter=unallocated`
 * will never hand it — hence the fourth value.
 *
 * A posted journal line still wins outright: a row can be excluded AFTER it was
 * allocated, and the money has moved either way.
 */
export function allocationStateOf(tx: BankTransaction): AllocationState {
  if (tx.matchedJournalLineId) return 'allocated';
  if (tx.status === 'excluded') return 'excluded';
  if (
    tx.suggestedGlAccountId || tx.suggestedSupplierId || tx.suggestedClientId || tx.allocationType
  ) {
    return 'suggested';
  }
  return 'unallocated';
}

/**
 * The service wraps the term in %…% for ILIKE and escapes nothing, so an
 * agent's "50%" or "ref_123" would match as a wildcard pattern. Escape the
 * three LIKE metacharacters (Postgres's default escape is backslash) so the
 * argument means what its name says: a literal substring.
 */
export function escapeLikeLiteral(term: string | undefined): string | undefined {
  if (term === undefined) return undefined;
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function toCompact(tx: BankTransaction): CompactBankTx {
  return {
    id: tx.id,
    date: tx.transactionDate,
    amount: tx.amount,
    // Two columns carry the statement reference and the one this field is
    // named after is the empty one in production (9,824 rows with `reference`,
    // ZERO with `bank_reference` on 2026-08-28 — statement importers write
    // `reference`; only the feed syncs write `bank_reference`, and they store
    // the provider's external id). Compact answered null on every row while
    // fields="full" showed the value, so an agent scanning compactly had
    // nothing to hand back to allocate_bank_transaction. `bankReference` still
    // wins where present: it is the stable external id, and the lookup
    // resolves either column.
    bank_reference: tx.bankReference ?? tx.reference ?? null,
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
    'Bank transactions, filterable by account, allocation state, and date range. ' +
    'limit is capped at 100 rows per call: a larger value is ACCEPTED and silently clamped to 100, so page with cursor rather than raising limit. ' +
    'allocation_filter: allocated = a journal has been posted; suggested = categorised/AI-suggested but not yet posted; unallocated = neither. ' +
    'Paging: the reply carries next_cursor whenever more rows match. To read a whole account, call again with cursor set to that value and every other argument unchanged, and keep looping until next_cursor is null. ' +
    'fields="compact" returns only id, date, amount, bank_reference and allocation (~10x smaller) — use it when you are scanning or bulk-allocating and do not need the full row. '
    + 'compact bank_reference is the statement reference from either column (the row\'s bank_reference, else its reference), which is exactly what allocate_bank_transaction and bulk_allocate_bank_transactions resolve. '
    + 'compact allocation is one of allocated | suggested | unallocated | excluded; an excluded row is returned by NEITHER allocation_filter=unallocated NOR =suggested, so never treat one as work to do.'
    + ' description_contains: case-insensitive substring matched against the statement description OR reference (a literal match — % and _ are not wildcards).',
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
      description_contains: {
        type: 'string',
        description: 'Case-insensitive substring of the description or reference.',
      },
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
    // bank_account_id lands as $n::UUID and the dates as $n::DATE.
    const bad = guardCastableArgs(args, {
      uuid: ['bank_account_id'],
      date: ['from_date', 'to_date'],
    });
    if (bad) return bad;
    try {
      const result = await getBankTransactions(ctx.companyId, {
        bankAccountId: strArg(args, 'bank_account_id'),
        allocationFilter,
        fromDate: strArg(args, 'from_date'),
        toDate: strArg(args, 'to_date'),
        limit: clampLimit(args, 50, 100),
        cursor: strArg(args, 'cursor'),
        search: escapeLikeLiteral(strArg(args, 'description_contains')),
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
