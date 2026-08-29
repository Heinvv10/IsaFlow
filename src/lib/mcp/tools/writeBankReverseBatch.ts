/**
 * MCP write tool: undo a whole bulk allocation.
 *
 * The other half of `bulk_allocate_bank_transactions` (writeBankBulkAllocate.ts),
 * split out to keep each file inside the 300-line cap. The two share nothing but
 * the batch id: allocate WRITES `bank_allocation_batches`, this reads it back and
 * reverses the journal behind every line the batch actually posted.
 *
 * ALL-OR-NOTHING, by the same mechanism as the allocate side: registry.call()
 * wraps the handler in ONE withSavepoint, which unwinds only on a THROW. So the
 * reversal loop has no try/catch — a half-reversed batch is worse than a failed
 * one, and only a throw rolls it back.
 */
import type { McpTool } from '../types';
import { reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import {
  clearAllocationBatch,
  getAllocationBatchLines,
} from '@/modules/accounting/services/bank/bankAllocationBatchService';
import { REVERSAL_DATE_PROPERTY } from './allocationSchema';
import { mcpPostingAgent } from '../postingAgent';
import { NOT_FOUND, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

const REVERSE_TOOL = 'reverse_bank_allocation_batch';

export const reverseBankAllocationBatchTool: McpTool = {
  name: REVERSE_TOOL,
  description:
    'Undo a whole bulk allocation: reverses the posted journal behind every transaction in the batch and '
    + 'returns them all to unallocated. The batch holds only the lines that actually POSTED — anything the '
    + 'allocate call skipped was never part of it and is not touched here. '
    + 'ALL OR NOTHING — if any reversal fails, none of them are applied. '
    + 'Transactions that have moved on since the batch posted (already reversed, or re-allocated to a '
    + 'different journal) are left untouched and listed in "skipped". '
    + 'The originals and their reversals both remain in the audit trail. '
    + "By default each reversing journal carries its ORIGINAL entry's date when that period is still "
    + 'open, and today when it is closed; pass reversal_date to date every reversal in the batch '
    + 'explicitly.',
  scope: 'write:bank-tx',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      batch_id: {
        type: 'string',
        description: 'The batch_id returned by bulk_allocate_bank_transactions.',
      },
      ...REVERSAL_DATE_PROPERTY,
      idempotency_key: { type: 'string' },
    },
    required: ['batch_id', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const batchId = strArg(args, 'batch_id');
    if (!batchId) return toolError('batch_id is required');
    // Shape-checked before the lookup: `${batchId}::uuid` on a malformed value
    // raises 22P02, which surfaces as the registry's generic failure and tells
    // the agent nothing about what it sent. Same shared guard every other tool
    // uses (toolHelpers, PR #266).
    const badBatchId = guardCastableArgs(args, { uuid: ['batch_id'] });
    if (badBatchId) return badBatchId;

    // One date for the whole batch. Validated per line inside
    // reverseJournalEntry against the entry each reverses, so a date that is
    // legal for one line and not another fails that line — and the batch is
    // all-or-nothing, so the whole thing unwinds rather than half-applying.
    const reversalDate = strArg(args, 'reversal_date');

    const batchLines = await getAllocationBatchLines(ctx.companyId, batchId);
    // Another tenant's batch reads identically to one that never existed.
    if (batchLines === null) return toolError(NOT_FOUND);

    // Only lines whose transaction still carries the journal THIS batch posted.
    // A row that was reversed on its own, or reversed and re-allocated
    // elsewhere, has moved on: reversing whatever journal happens to sit there
    // now would unwind a posting this batch never made. Skipped, not refused —
    // refusing would make a batch permanently unreversible because one row
    // changed, and the skipped set is reported so nothing is silent.
    const toReverse = batchLines.filter(
      (l) => l.transactionExists && l.currentJournalEntryId === l.journalEntryId,
    );
    const skipped = batchLines
      .filter((l) => !l.transactionExists || l.currentJournalEntryId !== l.journalEntryId)
      .map((l) => ({
        transaction_id: l.transactionId,
        reason: !l.transactionExists
          // Deleted since the batch posted (undo_bank_import, a manual delete).
          // Reported rather than dropped: a line the batch posted and can no
          // longer account for is the one a human most needs to see.
          ? 'transaction no longer exists'
          : l.currentJournalEntryId === null
            ? 'already reversed — no journal on this transaction'
            : 'allocated to a different journal since this batch posted',
      }));

    if (toReverse.length === 0) {
      // Nothing left for this batch to undo. Reported as a success so a retry
      // (or a second agent) is harmless rather than looking like a failure.
      return ok({ batch_id: batchId, reversed: 0, transaction_ids: [], skipped });
    }

    // Same deterministic lock order as the allocate handler: reversal locks the
    // same rows, so an unsorted loop deadlocks against a concurrent batch.
    const orderedReversals = [...toReverse].sort(
      (a, b) => (a.transactionId < b.transactionId ? -1 : a.transactionId > b.transactionId ? 1 : 0),
    );

    // No try/catch, same reasoning as the allocate handler: a half-reversed
    // batch is worse than a failed one, and only a throw rolls it back.
    for (const l of orderedReversals) {
      // The contra journal is stamped too — without it the agent's own
      // correction posts as human:<userId> and drops out of list_agent_postings.
      await reverseReconciledTransaction(ctx.companyId, l.transactionId, ctx.userId, {
        postingAgent: mcpPostingAgent(REVERSE_TOOL),
        ...(reversalDate === undefined ? {} : { reversalDate }),
      });
    }
    const reversedIds = orderedReversals.map((l) => l.transactionId);
    await clearAllocationBatch(ctx.companyId, batchId, reversedIds);

    return ok({
      batch_id: batchId,
      reversed: reversedIds.length,
      transaction_ids: reversedIds,
      skipped,
    });
  },
};
