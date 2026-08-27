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
import type { McpTool, McpToolContext } from '../types';
import { reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import {
  clearAllocationBatch,
  createAllocationBatch,
  getAllocationBatchTransactionIds,
  stampAllocationBatch,
} from '@/modules/accounting/services/bank/bankAllocationBatchService';
import {
  ALLOCATION_PROPERTIES,
  SELECTOR_PROPERTIES,
  type AllocationLine,
  checkLinesOwnership,
  parseAllocationLine,
  postAllocationLine,
  resolveTxId,
} from './allocationLine';
import { mcpPostingAgent } from '../postingAgent';
import { NOT_FOUND, ok, strArg, toolError } from './toolHelpers';

const BULK_TOOL = 'bulk_allocate_bank_transactions';
const REVERSE_TOOL = 'reverse_bank_allocation_batch';

// Each line posts a journal inside one request transaction, so the batch size
// bounds how long a single connection holds its locks. 500 matches the PRD and
// keeps the response (one id pair per line) well inside the transport's 1mb cap.
const MAX_LINES = 500;

interface ResolvedLine {
  txId: string;
  line: AllocationLine;
}

/** Parses, ownership-checks, resolves and de-duplicates. All reads — no writes. */
async function prepare(
  args: Record<string, unknown>,
  ctx: McpToolContext,
): Promise<ResolvedLine[] | string> {
  const raw = args.allocations;
  if (!Array.isArray(raw) || raw.length === 0) {
    return 'allocations must be a non-empty array';
  }
  // Checked BEFORE anything queries: a 5,000-line call must cost one refusal,
  // not 5,000 rows of reference resolution.
  if (raw.length > MAX_LINES) {
    return `allocations holds ${raw.length} lines — at most ${MAX_LINES} per call. Split the batch.`;
  }

  const lines: AllocationLine[] = [];
  for (const [i, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return `allocations[${i}] must be an object`;
    }
    const parsed = parseAllocationLine(entry as Record<string, unknown>);
    // The index matters: an agent holding 500 lines cannot act on "alloc_type
    // must be one of…" without being told which line it belongs to.
    if (typeof parsed === 'string') return `allocations[${i}]: ${parsed}`;
    lines.push(parsed);
  }

  const ownership = await checkLinesOwnership(ctx.companyId, lines);
  if (ownership) return ownership;

  const resolved: ResolvedLine[] = [];
  const seen = new Map<string, number>();
  for (const [i, line] of lines.entries()) {
    const r = await resolveTxId(line.selector, ctx.companyId);
    if ('error' in r) return `allocations[${i}]: ${r.error}`;
    // De-duplicated AFTER resolution, so two lines naming the same row by
    // different routes (a UUID and its bank_reference) are caught too. Left
    // through, the second line hits "Transaction already allocated" mid-write
    // and rolls back the other 499 — a refusal the agent can only fix by
    // re-sending, and a batch it cannot tell apart from a database failure.
    const prior = seen.get(r.id);
    if (prior !== undefined) {
      return `allocations[${i}] names transaction ${r.id}, already allocated by allocations[${prior}] in this call.`;
    }
    seen.set(r.id, i);
    resolved.push({ txId: r.id, line });
  }
  return resolved;
}

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
    const prepared = await prepare(args, ctx);
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

    // After the postings: allocateTransaction updates the same rows, and a
    // stamp written first would be clobbered by its UPDATE. Throws unless every
    // row was stamped — a posted journal outside the reversible set is exactly
    // what the batch id exists to prevent.
    await stampAllocationBatch(ctx.companyId, batchId, prepared.map((p) => p.txId));

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

    const txIds = await getAllocationBatchTransactionIds(ctx.companyId, batchId);
    // Another tenant's batch reads identically to one that never existed.
    if (txIds === null) return toolError(NOT_FOUND);
    if (txIds.length === 0) {
      // The batch exists but nothing still carries its stamp — already reversed.
      // Reported as a success with reversed: 0 so a retry is harmless.
      return ok({ batch_id: batchId, reversed: 0, transaction_ids: [] });
    }

    // No try/catch, same reasoning as the allocate handler: a half-reversed
    // batch is worse than a failed one, and only a throw rolls it back.
    for (const txId of txIds) {
      // The contra journal is stamped too — without it the agent's own
      // correction posts as human:<userId> and drops out of list_agent_postings.
      await reverseReconciledTransaction(ctx.companyId, txId, ctx.userId, {
        postingAgent: mcpPostingAgent(REVERSE_TOOL),
      });
    }
    await clearAllocationBatch(ctx.companyId, batchId, txIds);

    return ok({ batch_id: batchId, reversed: txIds.length, transaction_ids: txIds });
  },
};
