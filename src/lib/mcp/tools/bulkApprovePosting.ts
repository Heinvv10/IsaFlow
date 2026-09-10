/**
 * The posting half of the shared bulk-approve skeleton.
 *
 * Split from `bulkApproveRunner.ts`, which owns the pre-write partition: this
 * file owns what happens once a document is postable — one savepoint per
 * element, a lost race skipped rather than fatal, a deadlock rethrown so the
 * whole batch unwinds.
 */
import { withSavepoint } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { BulkAllocationLineError } from '../bulkAllocationLineError';
import { safeLineDetail } from './bulkAllocationPost';
import { getFiscalPeriodIdForDate } from '@/modules/accounting/services/gl/fiscalPeriodService';
import type { McpToolContext } from '../types';
import type { BulkApproveAdapter, SkippedDocument } from './bulkApproveRunner';

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

