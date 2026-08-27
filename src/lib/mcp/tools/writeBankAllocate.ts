/**
 * MCP write tools: allocate / reverse ONE bank transaction.
 *
 * allocateTransaction creates AND posts a journal entry, so these sit behind
 * write:post — the same explicit opt-in as post_journal. Every posting is
 * stamped mcp:<tool>:v1 so agent work is reviewable via list_agent_postings
 * and reversible via reverse_bank_allocation.
 *
 * The line parsing, tenant-ownership checks, bank_reference resolution and the
 * allocateTransaction call itself live in allocationLine.ts, shared verbatim
 * with bulk_allocate_bank_transactions. See the header there for why they are
 * not duplicated.
 */
import type { McpTool } from '../types';
import { reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import {
  ALLOCATION_PROPERTIES,
  SELECTOR_PROPERTIES,
  checkLinesOwnership,
  parseAllocationLine,
  pickTxSelector,
  postAllocationLine,
  resolveTxId,
} from './allocationLine';
import { mcpPostingAgent } from '../postingAgent';
import { ok, safeErrorText, toolError } from './toolHelpers';

export const allocateBankTransactionTool: McpTool = {
  name: 'allocate_bank_transaction',
  description:
    'Allocate one bank transaction to a GL account (optionally matching a supplier or customer invoice). '
    + 'Identify the transaction by transaction_id OR by bank_reference — the reference printed on the statement '
    + '— so you can allocate straight from a statement without fetching ids first (optionally narrowed by bank_account_id). '
    + 'POSTS a journal entry. Every allocation is attributed to the agent and can be undone with reverse_bank_allocation. '
    + 'To allocate many transactions at once, use bulk_allocate_bank_transactions.',
  scope: 'write:bank-tx',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      ...SELECTOR_PROPERTIES,
      ...ALLOCATION_PROPERTIES,
      idempotency_key: { type: 'string' },
    },
    required: ['idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const line = parseAllocationLine(args);
    if (typeof line === 'string') return toolError(line);

    const ownership = await checkLinesOwnership(ctx.companyId, [line]);
    if (ownership) return toolError(ownership);

    // Resolved LAST: a malformed call must be refused before it costs a query,
    // and an ambiguity message is only useful once the rest of the args are sane.
    const resolved = await resolveTxId(line.selector, ctx.companyId);
    if ('error' in resolved) return toolError(resolved.error);

    try {
      const result = await postAllocationLine(
        ctx.companyId,                                          // tenant from ctx ONLY
        ctx.userId,
        resolved.id,
        line,
        'allocate_bank_transaction',
      );
      return ok({
        journal_entry_id: result.journalEntryId,
        transaction_id: result.transactionId,
      });
    } catch (err) {
      // Safe to report rather than rethrow: this tool posts ONE line, and
      // bankAllocationService is internally atomic, so a throw here has left
      // nothing behind for a savepoint to roll back. The bulk tool is the
      // opposite case and rethrows — see writeBankBulkAllocate.ts.
      return toolError(safeErrorText(err, 'Failed to allocate the transaction.'));
    }
  },
};

export const reverseBankAllocationTool: McpTool = {
  name: 'reverse_bank_allocation',
  description:
    'Undo an allocation: reverses the posted journal and returns the bank transaction to unallocated. '
    + 'Identify the transaction by transaction_id OR by bank_reference — the reference printed on the statement '
    + '— optionally narrowed by bank_account_id. '
    + 'Use to correct a wrong allocation — the original and its reversal both remain in the audit trail. '
    + 'To undo a whole bulk allocation, use reverse_bank_allocation_batch.',
  scope: 'write:bank-tx',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      ...SELECTOR_PROPERTIES,
      idempotency_key: { type: 'string' },
    },
    required: ['idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const selector = pickTxSelector(args);
    if (typeof selector === 'string') return toolError(selector);

    const resolved = await resolveTxId(selector, ctx.companyId);
    if ('error' in resolved) return toolError(resolved.error);
    const txId = resolved.id;
    try {
      // The contra journal is stamped too: without it the agent's own
      // correction posts as human:<userId> and drops out of
      // list_agent_postings — the corrective mechanism would be the one write
      // that escapes the attribution model it depends on.
      await reverseReconciledTransaction(
        ctx.companyId,                                            // tenant from ctx ONLY
        txId,
        ctx.userId,
        { postingAgent: mcpPostingAgent('reverse_bank_allocation') },
      );
      return ok({ transaction_id: txId, reversed: true });
    } catch (err) {
      return toolError(safeErrorText(err, 'Failed to reverse the allocation.'));
    }
  },
};
