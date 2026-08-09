/**
 * MCP write tools: allocate / split-allocate / reverse a bank transaction.
 *
 * allocateTransaction creates AND posts a journal entry, so these sit behind
 * write:post — the same explicit opt-in as post_journal. Every posting is
 * stamped mcp:<tool>:v1 so agent work is reviewable via list_agent_postings
 * and reversible via reverse_bank_allocation.
 */
import type { McpTool } from '../types';
import {
  allocateTransaction,
  reverseReconciledTransaction,
} from '@/modules/accounting/services/bank/bankAllocationService';
import { mcpPostingAgent } from '../postingAgent';
import { ok, safeErrorText, toolError } from './toolHelpers';

// inputSchema.enum is NOT enforced by the MCP transport (schema is passed
// through to getManifest() only) — this array is the actual runtime gate.
// AllocationType in bankAllocationService also has a 'transfer' member with
// live bank-to-bank-transfer semantics; this tool deliberately does not
// expose it, so it must be rejected here rather than silently coerced.
const ALLOC_TYPES = ['account', 'supplier', 'customer'] as const;
type AllocType = (typeof ALLOC_TYPES)[number];

export const allocateBankTransactionTool: McpTool = {
  name: 'allocate_bank_transaction',
  description:
    'Allocate one bank transaction to a GL account (optionally matching a supplier or customer invoice). POSTS a journal entry. Every allocation is attributed to the agent and can be undone with reverse_bank_allocation.',
  scope: 'write:bank-tx',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      transaction_id: { type: 'string' },
      contra_account_id: { type: 'string' },
      description: { type: 'string' },
      alloc_type: { type: 'string', enum: [...ALLOC_TYPES] },
      entity_id: { type: 'string' },
      invoice_id: { type: 'string' },
      vat_code: { type: 'string', enum: ['standard', 'zero_rated', 'exempt', 'none'] },
      idempotency_key: { type: 'string' },
    },
    required: ['transaction_id', 'contra_account_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const txId = typeof args.transaction_id === 'string' ? args.transaction_id.trim() : '';
    const contra = typeof args.contra_account_id === 'string' ? args.contra_account_id.trim() : '';
    if (!txId) return toolError('transaction_id is required');
    if (!contra) return toolError('contra_account_id is required');

    const rawAllocType = args.alloc_type;
    let allocType: AllocType = 'account';
    if (rawAllocType !== undefined) {
      if (typeof rawAllocType !== 'string' || !ALLOC_TYPES.includes(rawAllocType as AllocType)) {
        return toolError(`alloc_type must be one of: ${ALLOC_TYPES.join(', ')}`);
      }
      allocType = rawAllocType as AllocType; // validated by the .includes() check above
    }

    try {
      const result = await allocateTransaction(
        ctx.companyId,                                            // tenant from ctx ONLY
        txId,
        contra,
        ctx.userId,
        typeof args.description === 'string' ? args.description : undefined,
        allocType,
        typeof args.entity_id === 'string' ? args.entity_id : undefined,
        typeof args.vat_code === 'string' ? args.vat_code : undefined,
        undefined,
        undefined,
        undefined,
        typeof args.invoice_id === 'string' ? args.invoice_id : undefined,
        { postingAgent: mcpPostingAgent('allocate_bank_transaction') },
      );
      return ok({
        journal_entry_id: result.journalEntryId,
        transaction_id: result.bankTransaction.id,
      });
    } catch (err) {
      return toolError(safeErrorText(err, 'Failed to allocate the transaction.'));
    }
  },
};

export const reverseBankAllocationTool: McpTool = {
  name: 'reverse_bank_allocation',
  description:
    'Undo an allocation: reverses the posted journal and returns the bank transaction to unallocated. Use to correct a wrong allocation — the original and its reversal both remain in the audit trail.',
  scope: 'write:bank-tx',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      transaction_id: { type: 'string' },
      idempotency_key: { type: 'string' },
    },
    required: ['transaction_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const txId = typeof args.transaction_id === 'string' ? args.transaction_id.trim() : '';
    if (!txId) return toolError('transaction_id is required');
    try {
      await reverseReconciledTransaction(ctx.companyId, txId, ctx.userId);  // tenant from ctx ONLY
      return ok({ transaction_id: txId, reversed: true });
    } catch (err) {
      return toolError(safeErrorText(err, 'Failed to reverse the allocation.'));
    }
  },
};
