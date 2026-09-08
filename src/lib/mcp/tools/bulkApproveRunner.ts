/**
 * The shared skeleton behind the three bulk APPROVE tools.
 *
 * `bulk_approve_supplier_invoices`, `bulk_finalize_invoices` and
 * `bulk_approve_credit_notes` differ only in which table they read, which
 * service posts, and what their result rows carry. Everything that makes a
 * batch write to the ledger SAFE is identical, so it lives here once: a batch
 * whose skip rules drifted from its sibling's would be a defect nobody could
 * see by reading either file.
 *
 * ── WHAT MAKES THIS DIFFERENT FROM THE BULK *CREATE* TOOLS ──────────────────
 *
 * `bulk_create_supplier_invoices` writes drafts — nothing reaches the ledger,
 * so its only failure mode is a malformed element. These tools POST. Every
 * element is an irreversible journal (reversible only by a further reversing
 * entry), which is why they carry `requiresPost` and why the partition below is
 * answered from reads before a single journal is built.
 *
 * ── REFUSE vs SKIP vs THROW ─────────────────────────────────────────────────
 *
 * The same three-way split the bulk allocate tool uses, because an agent that
 * has learned one batch tool must not have to learn a second contract:
 *
 *   REFUSE (toolError, pre-write, key left free) — a fault in the REQUEST. Bad
 *     shape, over the cap, a repeated id, a chart missing a system account. The
 *     caller must change what it sent, so nothing is attempted.
 *
 *   SKIP (counted, reported, batch continues) — a fault in the DATA for ONE
 *     document. Not found, wrong status, a closed fiscal period, a row locked
 *     by another request. None of these is the agent's mistake, and none may
 *     cost the other 99 documents. A batch where EVERY element skips still
 *     refuses, so a wholly wrong list cannot read as a silent success.
 *
 *   THROW (batch rolled back, nothing posted) — anything else. A closed period
 *     discovered mid-post, a deactivated account, a constraint, a driver fault.
 *     It is rethrown as `BulkAllocationLineError` so `registry.call()` unwinds
 *     the savepoint AND names the element. NEVER a `toolError` once posting has
 *     begun: a returned error RELEASES the savepoint and the transport's HTTP
 *     200 COMMITS the journals already posted.
 *
 * ── WHY EACH ELEMENT GETS ITS OWN SAVEPOINT ─────────────────────────────────
 *
 * Without one, a service throw leaves the request transaction aborted (25P02)
 * and the batch cannot continue even for a fault it is entitled to skip. The
 * lock-timeout skip below depends entirely on being able to carry on after a
 * throw. The batch as a whole still runs inside the registry's own savepoint,
 * which is what unwinds it.
 */

import { withSavepoint } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { BulkAllocationLineError } from '../bulkAllocationLineError';
import { safeLineDetail } from './bulkAllocationPost';
import { resolvePeriodSkips } from './bulkApprovePeriods';
import type { McpToolContext } from '../types';

/** One document the batch declined to touch, addressed by the agent's own index. */
export interface SkippedDocument {
  index: number;
  document_id: string;
  reason: string;
}

/** The current state of one document, as the pre-write partition reads it. */
export interface DocumentState {
  id: string;
  status: string;
  /** The date the journal will carry — what the fiscal-period verdict is read for. */
  entryDate: string | Date;
  /** The document's human-facing number, for the result rows. Read in the same
   *  query as the status so a result can name the bill an operator recognises
   *  rather than only its UUID. */
  documentNumber?: string;
  /** A per-document discriminator the tool needs after the partition — the
   *  credit-note arm's customer/supplier type, which decides which system
   *  accounts that element's journal will need. Carried HERE rather than in a
   *  module-level map: two concurrent requests share this module, and a map at
   *  module scope would have each batch reading the other's types. */
  documentType?: string;
}

/**
 * What one document type has to supply. Everything else is shared.
 *
 * `postOne` is the ONLY member allowed to write. It runs inside a per-element
 * savepoint and must let its failures throw — the runner decides what is a skip
 * and what unwinds the batch.
 */
export interface BulkApproveAdapter<TResult> {
  /** Tool name, for the posting stamp and the error text. */
  toolName: string;
  /** Savepoint prefix. Kept short: `withSavepoint` THROWS above 31 characters,
   *  which would fail the batch before it posted anything. */
  savepointPrefix: string;
  /** Statuses this document type may be approved from. */
  approvableStatuses: readonly string[];
  /** Read the current state of every named id, company-scoped, in ONE query.
   *  Ids absent from the returned map are reported as not found. */
  readStates(companyId: string, ids: readonly string[]): Promise<Map<string, DocumentState>>;
  /** Post one document. Throws on every failure; never returns an error shape. */
  postOne(ctx: McpToolContext, id: string): Promise<TResult>;
}

/** Everything the pre-write pass decided, before anything was written. */
export interface Partitioned {
  postable: { index: number; id: string }[];
  skipped: SkippedDocument[];
  /** What the pre-write read saw, so a tool can label its result rows without
   *  a second query. */
  states: Map<string, DocumentState>;
}

/**
 * Decide every element from READS alone.
 *
 * Run identically by `dry_run` and by the live call — that is the whole point.
 * A preview computed by different logic than the write is a preview of a
 * different batch, and the bank pilot proved how that reads: `dry_run` reported
 * an already-allocated row as postable and only the live call discovered it.
 */
export async function partitionDocuments(
  companyId: string,
  ids: readonly string[],
  adapter: BulkApproveAdapter<unknown>,
): Promise<Partitioned> {
  const states = await adapter.readStates(companyId, ids);

  // Periods are resolved only for documents that survived the status check.
  // A cancelled document's date is irrelevant, and reading it would let a
  // stale date mask the real reason the element was skipped.
  const candidates = ids
    .map((id, index) => ({ index, id, state: states.get(id) }))
    .filter((c) => c.state !== undefined && adapter.approvableStatuses.includes(c.state.status));
  const periodSkips = await resolvePeriodSkips(
    companyId, candidates.map((c) => c.state!.entryDate),
  );

  const postable: { index: number; id: string }[] = [];
  const skipped: SkippedDocument[] = [];

  for (let index = 0; index < ids.length; index++) {
    const id = ids[index]!;
    const state = states.get(id);
    // NOT_FOUND wording is deliberately the same for a missing row and another
    // tenant's row: a distinct reply would be an existence oracle, and the
    // read is company-scoped so a foreign id simply does not come back.
    if (!state) {
      skipped.push({ index, document_id: id, reason: 'not found' });
      continue;
    }
    if (!adapter.approvableStatuses.includes(state.status)) {
      // The STATUS is named, not swallowed. "cannot be approved" would tell an
      // agent its cancelled document had merely been posted already.
      skipped.push({
        index, document_id: id, reason: `status is ${state.status} — only ${adapter.approvableStatuses.join(' or ')} can be approved`,
      });
      continue;
    }
    const periodReason = periodSkips.get(fmtDate(state.entryDate));
    if (periodReason) {
      skipped.push({ index, document_id: id, reason: periodReason });
      continue;
    }
    postable.push({ index, id });
  }

  return { postable, skipped, states };
}

/** A lock timeout raised by any of the document locks. Write-free by
 *  construction — the lock is taken before anything is posted — so the element
 *  is skipped as retryable rather than failing the batch. Matched by CODE, not
 *  `instanceof`: the runner must not import three service modules just to
 *  compare constructors, and the code is the stable half of that contract. */
const LOCK_TIMEOUT_CODES = new Set([
  'SUPPLIER_INVOICE_LOCK_TIMEOUT',
  'CREDIT_NOTE_LOCK_TIMEOUT',
]);

function isLockTimeout(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null
    ? (err as { code?: unknown }).code
    : undefined;
  return typeof code === 'string' && LOCK_TIMEOUT_CODES.has(code);
}

export interface PostedBatch<TResult> {
  posted: TResult[];
  /** Documents that became unapprovable AFTER the partition — a lost race. */
  raced: SkippedDocument[];
}

/**
 * Post every partitioned document, each in its own savepoint.
 *
 * Sorted by id by the caller, never by the agent's send order: each element
 * takes a row lock held to the end of the request, so two overlapping batches
 * in opposite orders would deadlock (40P01). A total order makes that
 * impossible — the batch that arrives first simply blocks the other.
 */
export async function postPartitionedDocuments<TResult>(
  ctx: McpToolContext,
  ordered: readonly { index: number; id: string }[],
  adapter: BulkApproveAdapter<TResult>,
  /** Reads the settled status of a raced document, for the skip reason. */
  racedReason: (err: unknown) => string | null,
): Promise<PostedBatch<TResult>> {
  const posted: TResult[] = [];
  const raced: SkippedDocument[] = [];

  for (const { index, id } of ordered) {
    // Sequential, never Promise.all: these share one pg connection, and
    // concurrent statements on it interleave and corrupt the savepoint stack
    // (postgresql-gotchas §36).
    try {
      posted.push(await withSavepoint(
        `${adapter.savepointPrefix}${index}`,
        () => adapter.postOne(ctx, id),
      ));
    } catch (err) {
      if (isLockTimeout(err)) {
        raced.push({ index, document_id: id, reason: 'locked by another request — retry' });
        continue;
      }
      const settled = racedReason(err);
      if (settled !== null) {
        raced.push({ index, document_id: id, reason: settled });
        continue;
      }
      // NEVER err.message verbatim: the registry renders this text, and a pg
      // error's message names tables, columns and constraints.
      throw new BulkAllocationLineError(index, id, safeLineDetail(err));
    }
  }

  return { posted, raced };
}

