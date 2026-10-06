/**
 * The undo's result shapes, split out of autoPostUndoService.ts (which re-exports them) to keep that file under the
 * repo's 300-line ceiling.
 */
import type { HandOffset } from './autoPostHandOffset';

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
