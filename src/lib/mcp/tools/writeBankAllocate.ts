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
import { getBankTransactionStatus } from '@/modules/accounting/services/bank/bankTransactionLookupService';
import { ALLOCATION_PROPERTIES, REVERSAL_DATE_PROPERTY, SELECTOR_PROPERTIES } from './allocationSchema';
import {
  badUuidArg,
  checkLinesOwnership,
  parseAllocationLine,
  pickTxSelector,
  postAllocationLine,
  resolveTxId,
} from './allocationLine';
import { mcpPostingOpts } from '../mcpActor';
import { NOT_FOUND, ok, strArg, toolError } from './toolHelpers';

export const allocateBankTransactionTool: McpTool = {
  name: 'allocate_bank_transaction',
  description:
    'Allocate one bank transaction to a GL account (optionally matching a supplier or customer invoice). '
    + 'Identify the transaction by transaction_id OR by bank_reference — the reference printed on the statement '
    + '— so you can allocate straight from a statement without fetching ids first (optionally narrowed by bank_account_id). '
    + 'POSTS a journal entry. Every allocation is attributed to the agent and can be undone with reverse_bank_allocation. '
    + 'A vat_code of standard is REFUSED on accounts where no supply can arise (salaries and statutory deductions, '
    + 'taxes and penalties, distributions, depreciation, donations, and exempt financial services such as interest, '
    + 'loans and share investments) and on entertainment accounts where input tax is denied — the line still posts, '
    + 'gross, and the response carries vat_coerced saying what was changed and why. '
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

    // Refusals are checked HERE, before the service call, so that everything
    // the service throws can be rethrown. allocateTransaction raises the same
    // two refusals itself, but a `catch → toolError` around it cannot tell them
    // from a failure that struck AFTER the journal was posted (it posts the
    // entry, then updates the row in a separate statement). Reported as a tool
    // error, that partial write RELEASES the registry's savepoint and — since a
    // refusal is audited with a NULL idempotency key — the agent's retry on the
    // same key posts a SECOND journal.
    const status = await getBankTransactionStatus(ctx.companyId, resolved.id);
    if (status === null) return toolError(NOT_FOUND);
    if (status !== 'imported') {
      return toolError(`Transaction already ${status} — cannot allocate`);
    }

    // No try/catch below this line, deliberately. Anything the service throws
    // must reach the registry's savepoint, which rolls the partial write back
    // and makes the retry safe.
    const result = await postAllocationLine(
      ctx,                                                      // tenant + actor from ctx ONLY
      resolved.id,
      line,
      'allocate_bank_transaction',
    );
    return ok({
      journal_entry_id: result.journalEntryId,
      transaction_id: result.transactionId,
      // Present only when a guard changed the code. Returned rather than
      // swallowed so the agent can correct its next call — being silently
      // overruled teaches it nothing, and it is the caller that will allocate
      // the next hundred lines.
      ...(result.vatCoerced ? { vat_coerced: result.vatCoerced } : {}),
    });
  },
};

export const reverseBankAllocationTool: McpTool = {
  name: 'reverse_bank_allocation',
  description:
    'Undo an allocation: reverses the posted journal and returns the bank transaction to unallocated. '
    + 'Identify the transaction by transaction_id OR by bank_reference — the reference printed on the statement '
    + '— optionally narrowed by bank_account_id. '
    + 'Use to correct a wrong allocation — the original and its reversal both remain in the audit trail. '
    + "By default the reversing journal carries the ORIGINAL entry's date when that period is still open, "
    + 'and today when it is closed; pass reversal_date to choose it explicitly. '
    + 'To undo a whole bulk allocation, use reverse_bank_allocation_batch.',
  scope: 'write:bank-tx',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      ...SELECTOR_PROPERTIES,
      ...REVERSAL_DATE_PROPERTY,
      idempotency_key: { type: 'string' },
    },
    required: ['idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const selector = pickTxSelector(args);
    if (typeof selector === 'string') return toolError(selector);

    // Both ids reach pg as `$n::UUID` — transaction_id in
    // getBankTransactionStatus, bank_account_id in the reference lookup — so a
    // malformed one raised 22P02 from inside the handler instead of being
    // refused. The allocate tool has always been guarded (parseAllocationLine
    // does it); this path skipped it because it never parses a line.
    // Selector FIRST, cast-guard second, matching parseAllocationLine's
    // documented order: told 'invalid transaction_id' when it also sent a
    // bank_reference, an agent fixes the UUID and is refused again for naming
    // both.
    const badId = badUuidArg(args, ['transaction_id', 'bank_account_id']);
    if (badId) return toolError(badId);

    const reversalDate = strArg(args, 'reversal_date');

    const resolved = await resolveTxId(selector, ctx.companyId);
    if ('error' in resolved) return toolError(resolved.error);
    const txId = resolved.id;

    // Same pre-check-then-rethrow shape as allocate, and the exposure here is
    // the one that was proven on dev: reverseReconciledTransaction posts the
    // contra journal FIRST and resets the bank row second. A reset failure
    // returned as a tool error leaves the contra committed, and the retry — the
    // key having been freed — posts a SECOND contra against the same journal.
    const status = await getBankTransactionStatus(ctx.companyId, txId);
    if (status === null) return toolError(NOT_FOUND);
    if (status !== 'allocated' && status !== 'matched' && status !== 'reconciled') {
      return toolError('Can only reverse allocated, matched, or reconciled transactions');
    }

    // The contra journal is stamped too: without it the agent's own correction
    // posts as human:<userId> and drops out of list_agent_postings — the
    // corrective mechanism would be the one write that escapes the attribution
    // model it depends on.
    //
    // No try/catch: a mid-write failure must reach the registry's savepoint.
    await reverseReconciledTransaction(
      ctx.companyId,                                              // tenant from ctx ONLY
      txId,
      ctx.userId,
      {
        ...mcpPostingOpts(ctx, 'reverse_bank_allocation'),
        // Shape and ordering are validated inside reverseJournalEntry, which is
        // the one place that knows the entry being reversed. Passing it through
        // unchecked here keeps a single answer rather than two that can drift.
        ...(reversalDate === undefined ? {} : { reversalDate }),
      },
    );
    return ok({ transaction_id: txId, reversed: true });
  },
};
