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
 * answering GENERIC_FAILURE — and only pre-write refusals return a toolError.
 *
 * A REFUSAL IS ABOUT THE REQUEST; A SKIP IS ABOUT THE DATA. That is the line
 * the two shapes fall on. Shape, size, duplicates and cross-tenant ownership
 * are faults in what the caller SENT — it must change the request, so they
 * refuse the batch. Everything the DATA says about one line — already
 * allocated, excluded, not importable, the reference matches no row, the
 * reference matches several — is a skip: counted, reported with the agent's own
 * line index, and never allowed to cost the other 499 lines. A batch in which
 * every line skips still refuses, so a wholly wrong list cannot read as a
 * silent success.
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
import {
  createAllocationBatch,
  recordAllocationBatchLines,
} from '@/modules/accounting/services/bank/bankAllocationBatchService';
import { ALLOCATION_PROPERTIES, SELECTOR_PROPERTIES } from './allocationSchema';
import { MAX_LINES, prepareAllocationLines } from './bulkAllocationPrepare';
import { nothingToPostText, partitionAllocationLines } from './bulkAllocationSkip';
import { postPreparedLines } from './bulkAllocationPost';
import { ok, strArg, toolError } from './toolHelpers';

const BULK_TOOL = 'bulk_allocate_bank_transactions';

export const bulkAllocateBankTransactionsTool: McpTool = {
  name: BULK_TOOL,
  description:
    'Allocate up to 500 bank transactions in one call, each to a GL account (optionally matching a supplier '
    + 'or customer invoice). Identify each transaction by transaction_id OR by bank_reference — the reference '
    + 'printed on the statement. POSTS a journal entry per line. Transactions that are already allocated (or '
    + 'excluded, or otherwise not importable) are SKIPPED, not failures: they are listed in "skipped" with a '
    + 'reason and the rest of the batch still posts, so you can re-send a list without checking it first. '
    + 'A transaction_id or bank_reference that matches no transaction — or matches several — is also SKIPPED '
    + 'with a reason, so one unrecognised reference never costs you the rest of the batch. '
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
    // Not a micro-optimisation: when NOTHING resolved there are no ids to read
    // state for, and asking anyway makes the all-unresolved batch depend on a
    // query whose only correct answer is "nothing".
    const { postable, skipped: stateSkipped } = prepared.resolved.length > 0
      ? await partitionAllocationLines(ctx.companyId, prepared.resolved)
      : { postable: [], skipped: [] };
    // One list for the agent, in the order it sent the lines. The two skip
    // sources answer different questions — `prepared.skipped` is "this
    // reference names no row", `stateSkipped` is "the row it names has nothing
    // left to do" — but a caller reading its own batch back should not have to
    // know which stage refused which line.
    const skipped = [...prepared.skipped, ...stateSkipped]
      .sort((a, b) => a.index - b.index);

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
