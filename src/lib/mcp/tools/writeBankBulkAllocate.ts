/**
 * MCP write tools: allocate a whole set of bank transactions / reverse that set.
 *
 * PRD-11 §4. A single-account migration was costing one write call per
 * transaction; these take up to 500 lines at a time and make the result
 * addressable by one batch id.
 *
 * ALL-OR-NOTHING is the property that makes that safe. registry.call() wraps
 * every write tool in ONE withSavepoint, and that savepoint rolls back only
 * when the handler THROWS: a `catch → toolError` returns normally, the
 * savepoint RELEASES, and the transport's HTTP 200 lets bearerPipeline COMMIT
 * whatever the earlier lines already posted. So every failure from the first
 * allocateTransaction onwards is RETHROWN, and only pre-write refusals — shape,
 * size, duplicates, ownership, reference resolution — return a toolError. The
 * handler deliberately opens no savepoint of its own: the registry's is the one
 * savepoint the batch runs in.
 */
import type { McpTool } from '../types';
import { reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import {
  clearAllocationBatch,
  createAllocationBatch,
  getAllocationBatchLines,
  recordAllocationBatchLines,
} from '@/modules/accounting/services/bank/bankAllocationBatchService';
import { ALLOCATION_PROPERTIES, SELECTOR_PROPERTIES } from './allocationSchema';
import { postAllocationLine } from './allocationLine';
import { MAX_LINES, prepareAllocationLines } from './bulkAllocationPrepare';
import { mcpPostingAgent } from '../postingAgent';
import { NOT_FOUND, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

const BULK_TOOL = 'bulk_allocate_bank_transactions';
const REVERSE_TOOL = 'reverse_bank_allocation_batch';

export const bulkAllocateBankTransactionsTool: McpTool = {
  name: BULK_TOOL,
  description:
    'Allocate up to 500 bank transactions in one call, each to a GL account (optionally matching a supplier '
    + 'or customer invoice). Identify each transaction by transaction_id OR by bank_reference — the reference '
    + 'printed on the statement. POSTS a journal entry per line. ALL OR NOTHING: if any line fails, the whole '
    + 'batch is rolled back and nothing is posted. Every line is attributed to the agent, and the returned '
    + 'batch_id undoes the whole set through reverse_bank_allocation_batch. Use dry_run to see what would post.',
  scope: 'write:bank-tx',
  write: true,
  requiresPost: true,
  inputSchema: {
    type: 'object',
    properties: {
      allocations: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_LINES,
        description: `The lines to allocate — at most ${MAX_LINES}. Each names one transaction and how to book it.`,
        items: {
          type: 'object',
          properties: { ...SELECTOR_PROPERTIES, ...ALLOCATION_PROPERTIES },
          additionalProperties: false,
        },
      },
      dry_run: {
        type: 'boolean',
        description: 'Validate and resolve every line, report what would post, and write nothing.',
      },
      idempotency_key: { type: 'string' },
    },
    required: ['allocations', 'idempotency_key'],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const prepared = await prepareAllocationLines(args, ctx);
    if (typeof prepared === 'string') return toolError(prepared);

    if (args.dry_run === true) {
      // No batch row either: a dry run that left a batch behind would hand the
      // agent an id that reverses nothing.
      return ok({
        dry_run: true,
        batch_id: null,
        posted: 0,
        lines: prepared.map(({ txId, line }) => ({
          transaction_id: txId,
          contra_account_id: line.contraAccountId || null,
          alloc_type: line.allocType,
          entity_id: line.entityId || null,
          invoice_id: line.invoiceId ?? null,
          vat_code: line.vatCode ?? null,
          description: line.description ?? null,
        })),
      });
    }

    // ── Everything below is a WRITE. No try/catch: a throw must reach the
    // registry's savepoint, which is the only thing that unwinds the journals
    // already posted. Catching here would commit a half-allocated batch.
    const batchId = await createAllocationBatch(ctx.companyId, ctx.userId, {
      tool: BULK_TOOL,
      lineCount: prepared.length,
      idempotencyKey: strArg(args, 'idempotency_key') ?? null,
    });

    const lines: { transaction_id: string; journal_entry_id: string }[] = [];
    for (const { txId, line } of prepared) {
      // Sequential, not Promise.all: these share one pg connection, and
      // concurrent statements on it interleave (and corrupt the savepoint
      // stack — see the postgresql-gotchas §36 note).
      const result = await postAllocationLine(ctx.companyId, ctx.userId, txId, line, BULK_TOOL);
      lines.push({ transaction_id: result.transactionId, journal_entry_id: result.journalEntryId });
    }

    // After the postings, for two reasons: allocateTransaction now CLEARS
    // allocation_batch_id (so a stamp written first would be wiped by its own
    // UPDATE), and the journal ids being recorded do not exist until the lines
    // have posted. Throws unless every row was stamped — a posted journal
    // outside the reversible set is exactly what the batch id exists to prevent.
    await recordAllocationBatchLines(
      ctx.companyId,
      batchId,
      lines.map((l) => ({ transactionId: l.transaction_id, journalEntryId: l.journal_entry_id })),
    );

    return ok({
      batch_id: batchId,
      posted: lines.length,
      journal_entry_ids: lines.map((l) => l.journal_entry_id),
      lines,
    });
  },
};

export const reverseBankAllocationBatchTool: McpTool = {
  name: REVERSE_TOOL,
  description:
    'Undo a whole bulk allocation: reverses the posted journal behind every transaction in the batch and '
    + 'returns them all to unallocated. ALL OR NOTHING — if any reversal fails, none of them are applied. '
    + 'Transactions that have moved on since the batch posted (already reversed, or re-allocated to a '
    + 'different journal) are left untouched and listed in "skipped". '
    + 'The originals and their reversals both remain in the audit trail.',
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

    const batchLines = await getAllocationBatchLines(ctx.companyId, batchId);
    // Another tenant's batch reads identically to one that never existed.
    if (batchLines === null) return toolError(NOT_FOUND);

    // Only lines whose transaction still carries the journal THIS batch posted.
    // A row that was reversed on its own, or reversed and re-allocated
    // elsewhere, has moved on: reversing whatever journal happens to sit there
    // now would unwind a posting this batch never made. Skipped, not refused —
    // refusing would make a batch permanently unreversible because one row
    // changed, and the skipped set is reported so nothing is silent.
    const toReverse = batchLines.filter((l) => l.currentJournalEntryId === l.journalEntryId);
    const skipped = batchLines
      .filter((l) => l.currentJournalEntryId !== l.journalEntryId)
      .map((l) => ({
        transaction_id: l.transactionId,
        reason: l.currentJournalEntryId === null
          ? 'already reversed — no journal on this transaction'
          : 'allocated to a different journal since this batch posted',
      }));

    if (toReverse.length === 0) {
      // Nothing left for this batch to undo. Reported as a success so a retry
      // (or a second agent) is harmless rather than looking like a failure.
      return ok({ batch_id: batchId, reversed: 0, transaction_ids: [], skipped });
    }

    // No try/catch, same reasoning as the allocate handler: a half-reversed
    // batch is worse than a failed one, and only a throw rolls it back.
    for (const l of toReverse) {
      // The contra journal is stamped too — without it the agent's own
      // correction posts as human:<userId> and drops out of list_agent_postings.
      await reverseReconciledTransaction(ctx.companyId, l.transactionId, ctx.userId, {
        postingAgent: mcpPostingAgent(REVERSE_TOOL),
      });
    }
    const reversedIds = toReverse.map((l) => l.transactionId);
    await clearAllocationBatch(ctx.companyId, batchId, reversedIds);

    return ok({
      batch_id: batchId,
      reversed: reversedIds.length,
      transaction_ids: reversedIds,
      skipped,
    });
  },
};
