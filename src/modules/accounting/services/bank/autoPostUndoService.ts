/**
 * Auto-Post Undo Service
 * Reverses a whole auto-post run via the existing JE-reversal + tx-reset
 * plumbing, one savepoint per row. Reconciled transactions (books hygiene),
 * contended rows and failed rows are skipped and counted by reason; the rest
 * commit. The run is marked undone only when NOTHING was skipped — a skipped
 * row is still posted and still carries the run's tag, so "undone" would read
 * as "fully reversed" while it is not. Such a run stays open, and a retry
 * picks up exactly the rows still tagged.
 */

import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { reverseReconciledTransaction } from './bankAllocationService';
import { reverseJournalEntry } from '../gl/journalEntryService';
import { isRetryableContention } from '../core/retryableContention';

type Row = DbRow;

/**
 * Why a row was skipped — each has a different remedy for the user.
 * `reconciled`: unreconcile it first. `contended`: a peer holds it, retry.
 * `failed`: the reversal itself refused (a closed period, a row still marked
 * posted with nothing linked to reverse, a provisional journal whose reversal
 * was itself reversed); the reason is in the log.
 */
export interface UndoSkips {
  reconciled: number;
  contended: number;
  failed: number;
}

export interface UndoResult {
  reversed: number;
  /** The sum of `skippedBy`. */
  skipped: number;
  skippedBy: UndoSkips;
  /**
   * Rows carrying the run's tag with nothing left to reverse. The product
   * makes them: `unmatchTransaction` and `reverseReconciledTransaction` clear
   * `matched_journal_line_id` and leave `auto_post_run_id` set, and a user can
   * reverse a provisional JE by hand. The undo finishes such a row — clears the
   * tag, and for a hand-reversed JE resets the line to `imported` — without
   * posting anything, so it must not be counted in `reversed`, the number the
   * operator reconciles against.
   */
  alreadyUndone: number;
  /** TRUE only when `skipped` is 0 — the run was recorded undone. */
  undone: boolean;
}

/**
 * Savepoint name for one row of the undo. `withSavepoint` caps names at 31
 * characters, so this is a constant rather than an interpolation.
 */
const UNDO_ROW_SAVEPOINT = 'auto_post_undo_line';

/**
 * Statuses that claim a posting. A row in one of these with nothing linked to
 * reverse is NOT already undone — clearing its tag would let the run read
 * "undone" over a line the books still show as allocated.
 */
const POSTED_STATUSES = new Set(['provisional', 'allocated', 'matched', 'reconciled']);

type RowOutcome = 'reversed' | 'alreadyUndone' | 'unlinked' | 'reReversed';

/**
 * `none`: nothing reverses the journal. `live`: a reversal stands, so the
 * posting is off the books. `reReversed`: the reversal was itself reversed,
 * so the ORIGINAL posting is back on the books.
 */
type ReversalState = 'none' | 'live' | 'reReversed';

/**
 * How the journal stands NOW, not what `reversed_at` says.
 *
 * `reversed_at` on the original cannot answer it. Reversing a contra is an
 * ordinary permitted operation — `reverseJournalEntry` refuses only an entry
 * that is not posted or already reversed, and a contra is posted with
 * `reversed_at` NULL — and it does not clear the original's `reversed_at`. So
 * original + contra + contra-of-contra nets back to the ORIGINAL posting while
 * the original still reads "reversed", and reading the flag alone let the run
 * be marked undone with the money still on the expense and the bank account.
 *
 * Walk the chain instead. Each POSTED contra flips the sign, so an odd number
 * of them means the posting is off the books and an even number means it is
 * still on them. `ux_gl_je_reversal_of` (migration 619) is unique on
 * (company_id, reversal_of_id), so the chain is linear; the depth cap only
 * bounds a cycle that constraint should already make impossible.
 */
async function journalReversalState(companyId: string, journalEntryId: string): Promise<ReversalState> {
  const rows = (await sql`
    WITH RECURSIVE reversal_chain AS (
      SELECT id, 0 AS depth FROM gl_journal_entries
      WHERE id = ${journalEntryId}::UUID AND company_id = ${companyId}::UUID
      UNION ALL
      SELECT c.id, rc.depth + 1
      FROM gl_journal_entries c
      JOIN reversal_chain rc ON c.reversal_of_id = rc.id
      WHERE c.company_id = ${companyId}::UUID AND c.status = 'posted' AND rc.depth < 20
    )
    SELECT MAX(depth) AS depth FROM reversal_chain
  `) as Row[];
  const depth = Number(rows[0]?.depth ?? 0);
  if (depth === 0) return 'none';
  return depth % 2 === 1 ? 'live' : 'reReversed';
}

async function undoRow(companyId: string, runId: string, userId: string, tx: Row): Promise<RowOutcome> {
  const txId = String(tx.id);
  if (tx.matched_journal_line_id && tx.provisional_je_id) {
    log.warn(
      'Auto-post tx has both matched line and provisional JE — reversing matched line only',
      { companyId, runId, txId },
      'auto-post-undo',
    );
  }
  let outcome: RowOutcome = 'alreadyUndone';
  if (tx.matched_journal_line_id) {
    await reverseReconciledTransaction(companyId, txId, userId);
    outcome = 'reversed';
  } else if (tx.provisional_je_id) {
    const jeId = String(tx.provisional_je_id);
    const state = await journalReversalState(companyId, jeId);
    // The reversal was itself reversed, so the original posting is back on the
    // books — and `reverseJournalEntry` would refuse it ("already reversed"),
    // so this run has nothing it can do. Skip it: the tag stays, the run stays
    // open, and the operator sees a row to fix rather than an undo that read
    // "done" over money still in the GL.
    if (state === 'reReversed') return 'reReversed';
    // Reversed by hand already: a second reversal would be refused ("already
    // reversed") on every retry and the run could never close. The journal
    // nets to zero, so finishing the line is all that is left to do.
    if (state === 'none') {
      await reverseJournalEntry(companyId, jeId, userId);
      outcome = 'reversed';
    }
    await sql`
      UPDATE bank_transactions
      SET status = 'imported', provisional_je_id = NULL, updated_at = NOW()
      WHERE id = ${txId}::UUID AND company_id = ${companyId}::UUID
    `;
  } else if (POSTED_STATUSES.has(String(tx.status))) {
    return 'unlinked';
  }
  await sql`
    UPDATE bank_transactions SET auto_post_run_id = NULL
    WHERE id = ${txId}::UUID AND company_id = ${companyId}::UUID
  `;
  return outcome;
}

export async function undoRun(companyId: string, runId: string, userId: string): Promise<UndoResult> {
  const runRows = (await sql`
    SELECT id, undone_at FROM bank_auto_post_runs
    WHERE id = ${runId}::UUID AND company_id = ${companyId}::UUID
    LIMIT 1
  `) as Row[];
  if (runRows.length === 0) throw new Error(`Auto-post run ${runId} not found`);
  if (runRows[0]!.undone_at) throw new Error('Run already undone');

  const txRows = (await sql`
    SELECT id, status, matched_journal_line_id, provisional_je_id
    FROM bank_transactions
    WHERE auto_post_run_id = ${runId}::UUID AND company_id = ${companyId}::UUID
  `) as Row[];

  let reversed = 0;
  let alreadyUndone = 0;
  const skippedBy: UndoSkips = { reconciled: 0, contended: 0, failed: 0 };
  let contention: unknown = null;

  for (const tx of txRows) {
    const txId = String(tx.id);
    if (String(tx.status) === 'reconciled') {
      skippedBy.reconciled += 1;
      continue;
    }
    try {
      // Under its own savepoint, like the sibling sweep in autoPostGateService.
      // The body posts contra journals and takes row locks under a 5s
      // lock_timeout, so a contended or constraint-violating row raises a REAL
      // Postgres error inside the request transaction. Bare, the catch below
      // swallowed it while the transaction stayed aborted: every later row then
      // failed 25P02 and the trailing `undone` UPDATE threw. A savepoint makes
      // one failed row roll back alone.
      const outcome = await withSavepoint(UNDO_ROW_SAVEPOINT, () => undoRow(companyId, runId, userId, tx));
      if (outcome === 'reversed') {
        reversed += 1;
      } else if (outcome === 'alreadyUndone') {
        alreadyUndone += 1;
        log.info(
          'Auto-post undo found a tagged transaction with nothing to reverse — finished it without posting',
          { companyId, runId, txId },
          'auto-post-undo',
        );
      } else {
        skippedBy.failed += 1;
        log.error(
          outcome === 'reReversed'
            ? 'Auto-post undo skipped a transaction whose provisional journal reversal was itself reversed — the posting stands; run stays open'
            : 'Auto-post undo skipped a transaction marked posted with nothing linked to reverse — run stays open',
          { companyId, runId, txId, status: String(tx.status) },
          'auto-post-undo',
        );
      }
    } catch (err) {
      // The savepoint has rolled this row back alone — including
      // `reverseReconciledTransaction`'s bank-line lock, which it takes on the
      // enclosing transaction — so the request transaction is live and the
      // rows already reversed stand. Contention is skipped like any failure;
      // it is kept only to decide the answer below.
      if (isRetryableContention(err)) {
        contention ??= err;
        skippedBy.contended += 1;
        log.info('Auto-post undo skipped a contended transaction', { companyId, runId, txId }, 'auto-post-undo');
      } else {
        skippedBy.failed += 1;
        log.error(
          'Auto-post undo failed for transaction — run stays open; manual reversal required for this tx',
          { companyId, runId, txId, error: err instanceof Error ? err.message : String(err) },
          'auto-post-undo',
        );
      }
    }
  }

  // Nothing written at all, and a peer's lock is why: every savepoint rolled
  // back and skipped rows are never touched, so re-throwing makes the route
  // answer 409 with nothing committed behind it. Once any row has been written
  // the counts are the answer instead — a 4xx would COMMIT that work under a
  // failure status.
  if (contention !== null && reversed === 0 && alreadyUndone === 0) throw contention;

  const skipped = skippedBy.reconciled + skippedBy.contended + skippedBy.failed;
  const undone = skipped === 0;
  if (undone) {
    await sql`
      UPDATE bank_auto_post_runs
      SET undone_at = NOW(), undone_by = ${userId}::UUID
      WHERE id = ${runId}::UUID AND company_id = ${companyId}::UUID
    `;
  }

  log.info(
    undone ? 'Auto-post run undone' : 'Auto-post run partly undone — run stays open',
    { companyId, runId, reversed, skipped, skippedBy, alreadyUndone },
    'auto-post-undo',
  );
  return { reversed, skipped, skippedBy, alreadyUndone, undone };
}
