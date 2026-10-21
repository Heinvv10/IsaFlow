/**
 * Auto-Post Undo Service
 * Reverses a whole auto-post run via the existing JE-reversal + tx-reset
 * plumbing, one savepoint per row. Reconciled transactions (books hygiene),
 * contended rows, failed rows and rows a manual journal already offsets
 * (R-079 — never reversed on top of the user's correction) are skipped and
 * counted by reason; the rest
 * commit. The run is marked undone only when NOTHING was skipped — a skipped
 * row is still posted and still carries the run's tag, so "undone" would read
 * as "fully reversed" while it is not. Such a run stays open, and a retry
 * picks up exactly the rows still tagged.
 */

import { reconciliationLockOf, type LineLock } from './reconciledCash';
import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { reverseReconciledTransaction } from './bankAllocationService';
import { unwindBankAllocationApplication } from './bankAllocationUnwind';
import { reverseJournalEntry } from '../gl/journalEntryService';
import { isRetryableContention } from '../core/retryableContention';
import { isHeldRowError } from '@/lib/lockTimeout';
import { lockBankTransactionForUpdate } from './bankTxLock';
import { journalReversalState } from './journalReversalState';
import { lockChainHead } from '../shared/journalChainHead';
import { handOffsetOf, postingJournalOf, type HandOffset } from './autoPostHandOffset';
import { assertMayUndoRun, auditRunUndo } from './bankReversalGate';
import { postingRefOf, recordAutoPostUndone } from './codingDecisionLog';

type Row = DbRow;

/**
 * Why a row was skipped — each has a different remedy for the user.
 * `reconciled`: unreconcile it first. `contended`: a peer holds it, retry.
 * `failed`: the reversal itself refused (a closed period, a row still marked
 * posted with nothing linked to reverse, a provisional journal whose reversal
 * was itself reversed); the reason is in the log. `offsetByHand`: a manual
 * journal already offsets the posting (R-079) — reverse that journal, or
 * confirm it is the correction (autoPostHandCorrection.ts); `handOffsets`
 * names it.
 */
export interface UndoSkips {
  reconciled: number;
  contended: number;
  failed: number;
  offsetByHand: number;
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
  /** One entry per `offsetByHand` skip: the row and the journal that offsets it. */
  handOffsets: HandOffset[];
}

/**
 * Savepoint name for one row of the undo. `withSavepoint` caps names at 31
 * characters, so this is a constant rather than an interpolation.
 */
export const UNDO_ROW_SAVEPOINT = 'auto_post_undo_line';

/**
 * Statuses that claim a posting. A row in one of these with nothing linked to
 * reverse is NOT already undone — clearing its tag would let the run read
 * "undone" over a line the books still show as allocated.
 */
const POSTED_STATUSES = new Set(['provisional', 'allocated', 'matched', 'reconciled']);

export type RowOutcome = 'reversed' | 'alreadyUndone' | 'unlinked' | 'reReversed' | 'reconciled' | 'gone';

/** What one row came to; a hand-offset refusal carries the journal it found. */
export type RowResult = { kind: RowOutcome; lock?: LineLock } | { kind: 'offsetByHand'; offset: HandOffset };

/**
 * Undoes one row of a run, under the row lock. Exported for the recorded
 * "not the correction — undo anyway" decision, which undoes exactly one line.
 */
export async function undoRow(companyId: string, runId: string, userId: string, txId: string): Promise<RowResult> {
  // Locked and re-read before anything is decided, so a peer undo or a
  // confirmed hand correction (autoPostHandCorrection.ts, same lock) cannot
  // act on the same row in between: whichever comes second finds it gone.
  const tx = await lockBankTransactionForUpdate(companyId, txId);
  if (!tx || String(tx.auto_post_run_id ?? '') !== runId) return { kind: 'gone' };
  // The shared reconciled-cash rule (`reconciledCash.ts`), not a second copy:
  // a completed reconciliation or a Sage-reconciled line is a SKIP with its
  // reason, never a failed row. (This checked status 'reconciled' alone, so a
  // line whose reconciliation_id names a completed reconciliation fell through
  // to a reversal that now refuses it.)
  const lock = await reconciliationLockOf(companyId, tx);
  if (lock) return { kind: 'reconciled', lock }; // D12: undoAnyway answers a completed one with the shared 409
  if (tx.matched_journal_line_id && tx.provisional_je_id) {
    log.warn(
      'Auto-post tx has both matched line and provisional JE — reversing matched line only',
      { companyId, runId, txId },
      'auto-post-undo',
    );
  }
  let outcome: RowOutcome = 'alreadyUndone';
  const jeId = await postingJournalOf(companyId, tx);
  if (jeId) {
    // ONE path for both shapes — the matched line (bankRuleAutoPostLine) and
    // the provisional JE — so a hand-reversed posting is treated the same on
    // either. The reversal state comes FIRST: a posting already off the books
    // has nothing left for a "blocker" to correct, and scanning anyway sent
    // the user to reverse a legitimate journal (round-4 review).
    const state = await journalReversalState(companyId, jeId);
    // The reversal was itself reversed, so the original posting is back on the
    // books — and `reverseJournalEntry` would refuse it ("already reversed"),
    // so this run has nothing it can do. Skip it: the tag stays, the run stays
    // open, and the operator sees a row to fix rather than an undo that read
    // "done" over money still in the GL.
    if (state === 'reReversed') return { kind: 'reReversed' };
    if (state === 'none') {
      const offset = await handOffsetOf(companyId, tx); // R-079: never reversed on top of a person's correction
      if (offset) return { kind: 'offsetByHand', offset };
      if (tx.matched_journal_line_id) await reverseReconciledTransaction(companyId, txId, userId);
      else await reverseJournalEntry(companyId, jeId, userId);
      outcome = 'reversed';
    } else {
      // Reversed by hand already: a second reversal would be refused ("already
      // reversed") on every retry and the run could never close. The journal
      // nets to zero, but a hand reversal touches ONLY the ledger: the payment
      // document the posting minted and the bills or invoices it settled still
      // read as paid. `reverseReconciledTransaction` unwinds those BEFORE its
      // contra; the undo does the same here, so the subledger agrees with the
      // ledger when the line is finished. Idempotent (`status <> 'cancelled'`).
      // A provisional's line (no matched journal line) is re-decided under X's chain-head LOCK, after the line lock
      // (D10 round 2, brk-d10 O-b): the state above is an unlocked read, and a re-reversal landing before the reset
      // below would put X back in force under a line this frees. Now it waits; standing again -> skipped as above.
      if (!tx.matched_journal_line_id && (await lockChainHead(companyId, jeId))?.standing) return { kind: 'reReversed' };
      await unwindBankAllocationApplication(companyId, jeId);
    }
    if (state === 'live' && tx.matched_journal_line_id) {
      // The same reset `reverseReconciledTransaction` makes after its contra.
      await sql`
        UPDATE bank_transactions
        SET status = 'imported', matched_journal_line_id = NULL, reconciliation_id = NULL,
            linked_po_id = NULL, allocation_type = NULL, allocated_entity_name = NULL,
            allocation_rule_id = NULL, allocation_rule_name = NULL, allocation_batch_id = NULL,
            updated_at = NOW()
        WHERE id = ${txId}::UUID AND company_id = ${companyId}::UUID
      `;
    }
    if (!tx.matched_journal_line_id) {
      await sql`
        UPDATE bank_transactions
        SET status = 'imported', provisional_je_id = NULL, updated_at = NOW()
        WHERE id = ${txId}::UUID AND company_id = ${companyId}::UUID
      `;
    }
  } else if (POSTED_STATUSES.has(String(tx.status))) {
    return { kind: 'unlinked' };
  }
  await sql`
    UPDATE bank_transactions SET auto_post_run_id = NULL
    WHERE id = ${txId}::UUID AND company_id = ${companyId}::UUID
  `;
  // Non-fatal; inside the row's savepoint. A reversal above already recorded it; this covers the provisional
  // and reversed-by-hand shapes. Keyed on the posting the locked row carried, never "the latest auto-post".
  await recordAutoPostUndone(companyId, txId, userId, postingRefOf(tx));
  return { kind: outcome };
}

export async function undoRun(companyId: string, runId: string, userId: string): Promise<UndoResult> {
  const runRows = (await sql`
    SELECT id, undone_at FROM bank_auto_post_runs
    WHERE id = ${runId}::UUID AND company_id = ${companyId}::UUID
    LIMIT 1
  `) as Row[];
  if (runRows.length === 0) throw new Error(`Auto-post run ${runId} not found`);
  if (runRows[0]!.undone_at) throw new Error('Run already undone');
  const clearance = await assertMayUndoRun(companyId, runId, userId); // step 2 (decision 4): the RUN judged, before any row

  const txRows = (await sql`
    SELECT id, status, matched_journal_line_id, provisional_je_id, reconciliation_id
    FROM bank_transactions
    WHERE auto_post_run_id = ${runId}::UUID AND company_id = ${companyId}::UUID
    ORDER BY id
  `) as Row[];

  let reversed = 0;
  let alreadyUndone = 0;
  const skippedBy: UndoSkips = { reconciled: 0, contended: 0, failed: 0, offsetByHand: 0 };
  const handOffsets: HandOffset[] = [];
  let contention: unknown = null;

  for (const tx of txRows) {
    const txId = String(tx.id);
    // An unlocked fast path by the same shared rule; `undoRow` re-decides it
    // under the row lock.
    const lock = await reconciliationLockOf(companyId, tx);
    if (lock) {
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
      const result = await withSavepoint(UNDO_ROW_SAVEPOINT, () => undoRow(companyId, runId, userId, txId));
      const outcome = result.kind;
      if (result.kind === 'offsetByHand') {
        skippedBy.offsetByHand += 1;
        handOffsets.push(result.offset);
        log.warn(
          'Auto-post undo refused a transaction a manual journal already offsets — nothing posted; run stays open',
          { companyId, runId, txId, offsetJournalId: result.offset.journalEntryId },
          'auto-post-undo',
        );
      } else if (outcome === 'gone') {
        // A peer undo or a confirmed hand correction finished it first.
      } else if (outcome === 'reconciled') {
        skippedBy.reconciled += 1;
      } else if (outcome === 'reversed') {
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
      // it is kept only to decide the answer below. Every lock timeout is contention (D8 round 11): the bank
      // reversal's flow budget refuses a held bill or invoice after 5 s, and that row is not "failed".
      if (isRetryableContention(err) || isHeldRowError(err)) {
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

  await auditRunUndo(companyId, runId, userId, clearance, reversed + alreadyUndone);
  const skipped = skippedBy.reconciled + skippedBy.contended + skippedBy.failed + skippedBy.offsetByHand;
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
  return { reversed, skipped, skippedBy, alreadyUndone, undone, handOffsets };
}
