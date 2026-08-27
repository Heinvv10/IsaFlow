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
import { findBankTransactionsByReference } from '@/modules/accounting/services/bank/bankTransactionLookupService';
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

// ── Transaction selector (PRD-11 §5) ────────────────────────────────────────
//
// The agent reads a bank statement, not the database, so it holds the printed
// `bank_reference` rather than a UUID. Accepting it removes the
// list-everything-then-match step. Exactly one of the two: given both, they can
// name different rows and there is no safe precedence — a tie-break here would
// post against whichever the tool happened to prefer.

type TxSelector = { txId: string } | { ref: string; bankAccountId?: string };

/** Returns the selector, or the error text to refuse with. */
function pickTxSelector(args: Record<string, unknown>): TxSelector | string {
  const txId = typeof args.transaction_id === 'string' ? args.transaction_id.trim() : '';
  const ref = typeof args.bank_reference === 'string' ? args.bank_reference.trim() : '';
  if (txId && ref) {
    return 'Provide either transaction_id or bank_reference, not both — they may name different transactions.';
  }
  if (!txId && !ref) return 'transaction_id or bank_reference is required';
  if (txId) return { txId };
  // bank_account_id only NARROWS a query already fenced to ctx.companyId, so
  // it never becomes a foreign key and needs no ownership check of its own:
  // a foreign id simply matches nothing.
  const bankAccountId = typeof args.bank_account_id === 'string' ? args.bank_account_id.trim() : '';
  return bankAccountId ? { ref, bankAccountId } : { ref };
}

/** Resolves a selector to one transaction id, or the error text to refuse with. */
async function resolveTxId(
  sel: TxSelector,
  companyId: string,
): Promise<{ id: string } | { error: string }> {
  if ('txId' in sel) return { id: sel.txId };
  const matches = await findBankTransactionsByReference(companyId, sel.ref, sel.bankAccountId);
  // Same text as a genuine miss: a reference that resolves in another tenant
  // must read identically to one that exists nowhere (no existence oracle).
  if (matches.length === 0) return { error: NOT_FOUND };
  if (matches.length > 1) {
    // Never take the first: same-reference rows differ by date and amount, and
    // guessing posts this month's journal against last month's transaction.
    const listed = matches
      .map((m) => `${m.id} (${m.transactionDate}, ${m.amount.toFixed(2)})`)
      .join('; ');
    return {
      error: `bank_reference is ambiguous — ${matches.length} transactions carry it: ${listed}. `
        + 'Re-issue with transaction_id, or narrow with bank_account_id.',
    };
  }
  return { id: matches[0]!.id };
}

/** Schema fragment shared by both tools. */
const SELECTOR_PROPERTIES = {
  transaction_id: {
    type: 'string',
    description: 'Bank transaction UUID. Supply this OR bank_reference, not both.',
  },
  bank_reference: {
    type: 'string',
    description:
      'The reference printed on the bank statement, matched exactly (after trimming). '
      + 'Use it instead of transaction_id when working from a statement — no id lookup needed. '
      + 'Must resolve to exactly one transaction; if it does not, the tool lists the candidates.',
  },
  bank_account_id: {
    type: 'string',
    description: 'Optional: narrows a bank_reference lookup to one bank account.',
  },
} as const;

export const allocateBankTransactionTool: McpTool = {
  name: 'allocate_bank_transaction',
  description:
    'Allocate one bank transaction to a GL account (optionally matching a supplier or customer invoice). '
    + 'Identify the transaction by transaction_id OR by bank_reference — the reference printed on the statement '
    + '— so you can allocate straight from a statement without fetching ids first (optionally narrowed by bank_account_id). '
    + 'POSTS a journal entry. Every allocation is attributed to the agent and can be undone with reverse_bank_allocation.',
  scope: 'write:bank-tx',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      ...SELECTOR_PROPERTIES,
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
    required: ['idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const selector = pickTxSelector(args);
    if (typeof selector === 'string') return toolError(selector);
    const contra = typeof args.contra_account_id === 'string' ? args.contra_account_id.trim() : '';

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

    // Resolved LAST: a malformed call must be refused before it costs a query,
    // and an ambiguity message is only useful once the rest of the args are sane.
    const resolved = await resolveTxId(selector, ctx.companyId);
    if ('error' in resolved) return toolError(resolved.error);

    try {
      const result = await allocateTransaction(
        ctx.companyId,                                            // tenant from ctx ONLY
        resolved.id,
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
    'Undo an allocation: reverses the posted journal and returns the bank transaction to unallocated. '
    + 'Identify the transaction by transaction_id OR by bank_reference — the reference printed on the statement '
    + '— optionally narrowed by bank_account_id. '
    + 'Use to correct a wrong allocation — the original and its reversal both remain in the audit trail.',
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
