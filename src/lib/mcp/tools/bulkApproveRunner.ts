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
import {
  getFiscalPeriodIdForDate,
} from '@/modules/accounting/services/gl/fiscalPeriodService';
import type { OperationRef } from '@/modules/accounting/services/controls/contracts';
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
  /** A SECOND row this element will lock, when posting it touches more than the
   *  document itself — the credit-note arm's linked invoice, whose amount_paid
   *  the approval updates. Batches must be ordered by this before the document
   *  id, or two batches sharing one invoice can hold and wait crosswise. Empty
   *  when the element locks nothing but itself. */
  lockGroup?: string;
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
  /** The controlled operation the live post runs, so a preview can ask the
   *  kernel the same approval question the write would face. */
  operation: OperationRef['operation'];
  entityType: string;
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
  options?: { preview?: boolean },
): Promise<Partitioned> {
  const states = await adapter.readStates(companyId, ids);

  // Periods are resolved only for documents that survived the status check.
  // A cancelled document's date is irrelevant, and reading it would let a
  // stale date mask the real reason the element was skipped.
  const candidates = ids
    .map((id, index) => ({ index, id, state: states.get(id) }))
    .filter((c) => c.state !== undefined
      && adapter.approvableStatuses.includes(c.state.status)
      // An undated document is skipped below; asking for a period verdict on ''
      // would reach the auto-create branch, where fiscalYearOfDate throws.
      && fmtDate(c.state.entryDate) !== '');
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
    // `customer_invoices.invoice_date` is NULLABLE (its supplier and credit-note
    // twins are NOT NULL). fmtDate(null) is '', which matches no period window
    // and would fall through to the auto-create branch, where fiscalYearOfDate
    // throws on an unparseable date — a whole batch lost to one undated row.
    // There are none in dev today; the column permits them.
    const entryDate = fmtDate(state.entryDate);
    if (!entryDate) {
      skipped.push({
        index, document_id: id,
        reason: 'has no document date, so no fiscal period can be resolved for it',
      });
      continue;
    }
    const periodReason = periodSkips.get(entryDate);
    if (periodReason) {
      skipped.push({ index, document_id: id, reason: periodReason });
      continue;
    }
    postable.push({ index, id });
  }

  // A preview must not report a document as one that would post when the live
  // call would refuse it for want of an independent approval. Only a preview
  // asks: the live path meets the same condition inside the control kernel,
  // where it refuses the batch rather than silently dropping a document.
  if (options?.preview === true && postable.length > 0) {
    const { controlledOperationApprovalRequired } = await import('@/modules/accounting/services/controls/approvalExecutionService');
    const { requireControlTx } = await import('@/modules/accounting/services/controls/context');
    const bound: typeof postable = [];
    for (const candidate of postable) {
      const required = await controlledOperationApprovalRequired(requireControlTx(),
        { entityType: adapter.entityType, entityId: candidate.id, operation: adapter.operation });
      if (required) {
        skipped.push({ index: candidate.index, document_id: candidate.id,
          reason: 'an independent approval is required for this operation — request one with request_operation_approval, then retry' });
      } else bound.push(candidate);
    }
    postable.length = 0;
    postable.push(...bound);
    skipped.sort((a, b) => a.index - b.index);
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
  'CUSTOMER_INVOICE_LOCK_TIMEOUT',
]);

/** Postgres `deadlock_detected` — this transaction was chosen as the victim. */
function isDeadlock(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as { code?: unknown }).code === '40P01';
}

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
  ordered: readonly { index: number; id: string; entryDate?: string | Date }[],
  adapter: BulkApproveAdapter<TResult>,
  /** Reads the settled status of a raced document, for the skip reason. */
  racedReason: (err: unknown) => string | null,
): Promise<PostedBatch<TResult>> {
  const posted: TResult[] = [];
  const raced: SkippedDocument[] = [];

  for (const { index, id, entryDate } of ordered) {
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
      // A DEADLOCK is fatal but RETRYABLE, and saying so is the difference
      // between an agent re-sending the batch and an agent giving up on it.
      // Postgres has already chosen this transaction as the victim and aborted
      // it, so the batch cannot continue and must unwind — but nothing is wrong
      // with the request, and the identical call will usually succeed. Left to
      // safeLineDetail it reads as `database error 40P01`, which names no
      // action. The ordering above makes this rare rather than impossible:
      // callers outside these tools (the supplier-invoice bulk-action route,
      // the UI) can still walk the same rows in a different order.
      if (isDeadlock(err)) {
        throw new BulkAllocationLineError(
          index, id,
          'deadlocked against another request holding these rows — nothing was posted, retry the batch',
        );
      }
      // AUTO-CREATABLE IS NOT THE SAME AS CREATED, and the pre-check cannot
      // see the difference. `resolvePeriodSkips` passes any date whose fiscal
      // year is inside the auto-create window, on the assumption that
      // `ensureFiscalPeriodForDate` will build it. That call RETHROWS when the
      // build genuinely fails and no period exists afterwards — which happens
      // in two ordinary situations: a partially-created year (some period rows
      // already carry that `fiscal_year` label, so `createFiscalYear` refuses
      // as "already exists") and a computed range that overlaps existing
      // periods (`FiscalPeriodOverlapError`). Either one, on element 37 of a
      // historical reload, would unwind all 100 — the exact outcome the period
      // pre-check exists to prevent, reached through the branch it added.
      //
      // Decided by OUTCOME, never by the error's text or SQLSTATE: does a
      // period cover this date NOW? The element's savepoint has already rolled
      // back, so anything the failed creation wrote is gone and the connection
      // is usable. If no period covers the date, the element could not have
      // posted for a reason that is about this document's date alone — a skip,
      // like the closed period it sits beside. (`fiscalPeriodAutoCreate` itself
      // decides its own race the same way, and for the same reason: matching
      // messages rots on the next shape pg words differently.)
      if (entryDate) {
        const covering = await getFiscalPeriodIdForDate(ctx.companyId, entryDate);
        if (!covering) {
          raced.push({
            index, document_id: id,
            reason: `no fiscal period could be resolved or created for ${fmtDate(entryDate)}`
              + ' — create the fiscal year, then retry this document',
          });
          continue;
        }
      }
      // NEVER err.message verbatim: the registry renders this text, and a pg
      // error's message names tables, columns and constraints.
      throw new BulkAllocationLineError(index, id, safeLineDetail(err));
    }
  }

  return { posted, raced };
}

