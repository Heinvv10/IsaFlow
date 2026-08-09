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
import { accountsBelongToCompany } from '@/modules/accounting/services/gl/chartOfAccountsService';
import {
  customerBelongsToCompany,
  supplierBelongsToCompany,
} from '@/modules/accounting/services/core/contactDirectoryService';
import { mcpPostingAgent } from '../postingAgent';
import { NOT_FOUND, ok, safeErrorText, toolError } from './toolHelpers';

// inputSchema.enum is NOT enforced by the MCP transport (schema is passed
// through to getManifest() only) — this array is the actual runtime gate.
// AllocationType in bankAllocationService also has a 'transfer' member with
// live bank-to-bank-transfer semantics; this tool deliberately does not
// expose it, so it must be rejected here rather than silently coerced.
const ALLOC_TYPES = ['account', 'supplier', 'customer'] as const;
type AllocType = (typeof ALLOC_TYPES)[number];

// Same reasoning, same runtime gate. bankAllocationService maps any value it
// doesn't recognise to `undefined` (mapVatType), which posts the line with NO
// VAT type at all — a typo like 'zero-rated' silently drops the VAT201
// classification off a journal that still balances. Reject, never coerce.
const VAT_CODES = ['standard', 'zero_rated', 'exempt', 'none'] as const;
type VatCode = (typeof VAT_CODES)[number];

// allocateTransaction gates its supplier/customer branches on `allocType &&
// entityId`; a falsy entityId falls through to the plain GL-account branch and
// posts a structurally different journal (no AP/AR control account, no match)
// under a success response. The REST route over the same service rejects this
// explicitly — see pages/api/accounting/bank-transactions-action.ts.
const ENTITY_REQUIRED: readonly AllocType[] = ['supplier', 'customer'];

// allocateTransaction reads contraAccountId ONLY in its `account` branch —
// supplier/customer resolve their contra side from getSystemAccountId
// ('payable'/'receivable'). Requiring it everywhere made the agent invent a GL
// account for a supplier payment that then went unused. The REST route over the
// same service already gets this right (bank-transactions-action.ts: required
// for account/transfer only).
const CONTRA_REQUIRED: readonly AllocType[] = ['account'];

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
      contra_account_id: {
        type: 'string',
        description:
          'GL account UUID the other side of the transaction is booked to. Required for alloc_type "account" (the default); ignored for supplier/customer, which post to the AP/AR control account.',
      },
      description: { type: 'string' },
      alloc_type: { type: 'string', enum: [...ALLOC_TYPES] },
      entity_id: { type: 'string' },
      invoice_id: { type: 'string' },
      vat_code: { type: 'string', enum: [...VAT_CODES] },
      idempotency_key: { type: 'string' },
    },
    required: ['transaction_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const txId = typeof args.transaction_id === 'string' ? args.transaction_id.trim() : '';
    const contra = typeof args.contra_account_id === 'string' ? args.contra_account_id.trim() : '';
    if (!txId) return toolError('transaction_id is required');

    const rawAllocType = args.alloc_type;
    let allocType: AllocType = 'account';
    if (rawAllocType !== undefined) {
      if (typeof rawAllocType !== 'string' || !ALLOC_TYPES.includes(rawAllocType as AllocType)) {
        return toolError(`alloc_type must be one of: ${ALLOC_TYPES.join(', ')}`);
      }
      allocType = rawAllocType as AllocType; // validated by the .includes() check above
    }

    const rawVatCode = args.vat_code;
    let vatCode: VatCode | undefined;
    if (rawVatCode !== undefined) {
      if (typeof rawVatCode !== 'string' || !VAT_CODES.includes(rawVatCode as VatCode)) {
        return toolError(`vat_code must be one of: ${VAT_CODES.join(', ')}`);
      }
      vatCode = rawVatCode as VatCode; // validated by the .includes() check above
    }

    const entityId = typeof args.entity_id === 'string' ? args.entity_id.trim() : '';
    if (ENTITY_REQUIRED.includes(allocType) && !entityId) {
      return toolError(`entity_id is required for ${allocType} allocation`);
    }
    if (CONTRA_REQUIRED.includes(allocType) && !contra) {
      return toolError(`contra_account_id is required for ${allocType} allocation`);
    }

    // ── Ownership ─────────────────────────────────────────────────────────
    // These ids arrive from the agent, and NOTHING downstream re-checks the
    // tenant: allocateTransaction looks the contra account up only to build a
    // display label, sets it null on zero rows, and posts the line anyway;
    // there is no composite (id, company_id) FK to catch it. A foreign
    // contra_account_id therefore books this company's bank money into another
    // tenant's account, and a foreign entity_id books it against another
    // tenant's creditor/debtor.
    //
    // The error text is deliberately identical to a genuine miss (NOT_FOUND).
    // A distinguishable "belongs to another company" reply would turn this
    // tool into an existence oracle: an agent could probe UUIDs and learn
    // which ones are real in tenants it cannot read.
    if (contra && !(await accountsBelongToCompany(ctx.companyId, [contra]))) {
      return toolError(NOT_FOUND);
    }
    if (allocType === 'supplier' && !(await supplierBelongsToCompany(ctx.companyId, entityId))) {
      return toolError(NOT_FOUND);
    }
    if (allocType === 'customer' && !(await customerBelongsToCompany(ctx.companyId, entityId))) {
      return toolError(NOT_FOUND);
    }

    try {
      const result = await allocateTransaction(
        ctx.companyId,                                            // tenant from ctx ONLY
        txId,
        contra || null,   // null for supplier/customer — the service ignores it there
        ctx.userId,
        typeof args.description === 'string' ? args.description : undefined,
        allocType,
        entityId || undefined,
        vatCode,
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
