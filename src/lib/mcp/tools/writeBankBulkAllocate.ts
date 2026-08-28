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
 * whatever the earlier lines already posted. So every genuine failure from the
 * first allocateTransaction onwards is RETHROWN — as a typed
 * BulkAllocationLineError, so the registry can name the line instead of
 * answering GENERIC_FAILURE — and only pre-write refusals (shape, size,
 * duplicates, ownership, reference resolution, nothing-left-to-post) return a
 * toolError.
 *
 * ALREADY-ALLOCATED IS NOT A FAILURE (PRD §4). A batch assembled off a
 * statement routinely names rows the books already carry. Those are skipped,
 * counted and reported — decided by a single pre-write state read
 * (bulkAllocationSkip.ts), which is what makes dry_run and the live call agree.
 * A row that becomes allocated between that read and its post is the same
 * outcome by a different route, so the posting loop counts it as a skip too;
 * that is the only reason the loop opens a savepoint PER LINE (a service throw
 * would otherwise leave the request transaction aborted). The batch as a whole
 * still runs in the registry's savepoint, which is what unwinds it.
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
import { MAX_LINES, prepareAllocationLines } from './bulkAllocationPrepare';
import { nothingToPostText, partitionAllocationLines } from './bulkAllocationSkip';
import { postPreparedLines } from './bulkAllocationPost';
import { mcpPostingAgent } from '../postingAgent';
import { NOT_FOUND, guardCastableArgs, ok, strArg, toolError } from './toolHelpers';

const BULK_TOOL = 'bulk_allocate_bank_transactions';
const REVERSE_TOOL = 'reverse_bank_allocation_batch';

export const bulkAllocateBankTransactionsTool: McpTool = {
  name: BULK_TOOL,
  description:
    'Allocate up to 500 bank transactions in one call, each to a GL account (optionally matching a supplier '
    + 'or customer invoice). Identify each transaction by transaction_id OR by bank_reference — the reference '
    + 'printed on the statement. POSTS a journal entry per line. Transactions that are already allocated (or '
    + 'excluded, or otherwise not importable) are SKIPPED, not failures: they are listed in "skipped" with a '
    + 'reason and the rest of the batch still posts, so you can re-send a list without checking it first. '
    + 'ALL OR NOTHING for real faults: if a line genuinely fails, the whole batch is rolled back, nothing is '
    + 'posted, and the error names the line. Every line is attributed to the agent, and the returned batch_id '
    + 'undoes the posted set through reverse_bank_allocation_batch. Use dry_run to see what would post and '
    + 'what would be skipped.',
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

    // PRD §4: a row that is already allocated is SKIPPED, not fatal. Read the
    // CURRENT state of every resolved row in one query, on the pre-write side
    // of the boundary, so `dry_run` and the live call answer identically and
    // neither discovers it from inside allocateTransaction — where the only
    // available shape is a throw, and a throw fails the whole batch.
    const partition = await partitionAllocationLines(ctx.companyId, prepared);
    if (typeof partition === 'string') return toolError(partition);
    const { postable, skipped } = partition;

    if (args.dry_run === true) {
      // No batch row either: a dry run that left a batch behind would hand the
      // agent an id that reverses nothing.
      const preview = ok({
        dry_run: true,
        batch_id: null,
        posted: 0,
        would_post: postable.length,
        skipped,
        lines: postable.map(({ txId, line }) => ({
          transaction_id: txId,
          contra_account_id: line.contraAccountId || null,
          alloc_type: line.allocType,
          entity_id: line.entityId || null,
          invoice_id: line.invoiceId ?? null,
          vat_code: line.vatCode ?? null,
          description: line.description ?? null,
        })),
      });
      // Wrote nothing, so it must not occupy the idempotency key: the real call
      // that follows carries the same intent and would otherwise be served this
      // preview forever. Also free — nothing was posted.
      preview.wroteNothing = true;
      preview.billable = false;
      return preview;
    }

    if (postable.length === 0) {
      // Refused BEFORE a batch is opened, and deliberately not reported as a
      // success: an empty batch hands the agent an id that reverses nothing,
      // and a silent "posted: 0" reads like the work was done. Pre-write, so a
      // toolError is the correct shape — there is nothing to unwind, and the
      // registry audits it with a NULL key, leaving the key usable once the
      // agent has fixed its list.
      return toolError(nothingToPostText(skipped));
    }

    // ── Everything below is a WRITE. No try/catch around the batch: a throw
    // must reach the registry's savepoint, which is the only thing that unwinds
    // the journals already posted. Catching here would commit a half-allocated
    // batch. (postPreparedLines catches per line, and either rethrows as a
    // typed BulkAllocationLineError or records a lost race as a skip — it never
    // swallows a fault.)
    //
    // Sorted by transaction id, NOT the order the agent sent them. Each line
    // takes a row lock (bankTxLock) and holds it to the end of the request, so
    // two batches that overlap in the opposite order would deadlock on each
    // other (40P01) — A holds tx1 waiting on tx2 while B holds tx2 waiting on
    // tx1. A total order over the locked rows makes that impossible: the batch
    // that gets there first simply blocks the other.
    const ordered = [...postable].sort((a, b) => (a.txId < b.txId ? -1 : a.txId > b.txId ? 1 : 0));
    const { lines, raced } = await postPreparedLines(
      ctx.companyId, ctx.userId, ordered, BULK_TOOL,
    );
    // Ordered by the agent's own line index: `skipped` is a list a human reads
    // against the batch they sent, and the pre-check and race entries arrive in
    // different orders.
    const allSkipped = [...skipped, ...raced].sort((a, b) => a.index - b.index);

    if (lines.length === 0) {
      // Every postable line lost its race. Nothing was written, so no batch is
      // opened and the key is left free — the same reasoning as the dry run.
      const nothing = ok({
        batch_id: null, posted: 0, journal_entry_ids: [], lines: [], skipped: allSkipped,
      });
      nothing.wroteNothing = true;
      nothing.billable = false;
      return nothing;
    }

    // Opened AFTER the postings so `line_count` is what the batch actually
    // posted rather than what was proposed: the count is the only summary a
    // human reading `bank_allocation_batches` gets, and one that includes
    // skipped lines describes a batch that does not exist.
    const batchId = await createAllocationBatch(ctx.companyId, ctx.userId, {
      tool: BULK_TOOL,
      lineCount: lines.length,
      idempotencyKey: strArg(args, 'idempotency_key') ?? null,
    });

    // After the postings for two more reasons: allocateTransaction CLEARS
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
      skipped: allSkipped,
    });
  },
};

export const reverseBankAllocationBatchTool: McpTool = {
  name: REVERSE_TOOL,
  description:
    'Undo a whole bulk allocation: reverses the posted journal behind every transaction in the batch and '
    + 'returns them all to unallocated. The batch holds only the lines that actually POSTED — anything the '
    + 'allocate call skipped was never part of it and is not touched here. '
    + 'ALL OR NOTHING — if any reversal fails, none of them are applied. '
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
