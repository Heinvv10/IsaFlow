/**
 * bankTransferLinkPasses — the repeat-until-settled runner both transfer link
 * passes in bankTransferLinkService share.
 *
 * Split from the queries because it is a different concern: the savepoint that
 * keeps a swallowed failure from aborting the request transaction, and the loop
 * that lets a beaten runner-up reach its second-best line.
 */

import { withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';

export type Row = Record<string, unknown>;

/**
 * Outcome of a link pass. `failed` distinguishes "nothing to link" from "the
 * pass errored": both used to return 0, so a caller (and the UI behind
 * `bank-relink-transfers`) could not tell them apart.
 */
export interface TransferLinkResult {
  linked: number;
  failed: boolean;
}

/**
 * A pass links every non-conflicting pair it can find, so N rows contending for
 * N free lines settle in ONE pass. Repeats exist for the leftovers of a partial
 * overlap, where a beaten row's second-best line only becomes reachable once the
 * winner's line is claimed.
 *
 * Termination. Take the candidate pair minimising
 * (date_distance, new_tx_id, target_je_line_id). It is rank 1 in its line's
 * partition (nothing has a smaller distance, and among equals nothing has a
 * smaller new_tx_id) and rank 1 in its transaction's partition (same distance
 * argument, and among that transaction's equals nothing has a smaller line id),
 * so it always survives `tx_rank = line_rank`. Every non-empty candidate set
 * therefore links at least one row; the linked row leaves `status = 'imported'`
 * and its line is excluded by the anti-join, so the candidate set strictly
 * shrinks. Passes are bounded by the number of free lines.
 *
 * The cap is an anti-hang guard against a future edit breaking that invariant,
 * not a work limit: reaching it means a pass linked rows without shrinking the
 * candidate set, which is a bug rather than a large account.
 */
const MAX_LINK_PASSES = 10_000;

/**
 * Repeat `pass` until it links nothing, inside ONE savepoint.
 *
 * The savepoint is what makes the swallowing catch safe: both callers run
 * inside the request transaction, where an error rolled back only by the catch
 * leaves the connection aborted (25P02) and every later statement in the
 * request fails.
 */
export async function runLinkPasses(
  label: string,
  savepointName: string,
  context: Record<string, unknown>,
  pass: () => Promise<Row[]>,
): Promise<TransferLinkResult> {
  try {
    return await withSavepoint(savepointName, async () => {
      let linked = 0;
      let passes = 0;
      for (;;) {
        const rows = await pass();
        if (rows.length === 0) break;
        linked += rows.length;
        passes += 1;
        if (passes >= MAX_LINK_PASSES) {
          log.error(`${label} hit the pass cap — a pass linked rows without consuming candidates`,
            { ...context, linked }, 'accounting');
          break;
        }
      }
      if (linked > 0) log.info(label, { ...context, linked }, 'accounting');
      return { linked, failed: false };
    });
  } catch (err) {
    log.warn(`${label} failed — non-fatal`, { ...context, error: err }, 'accounting');
    return { linked: 0, failed: true };
  }
}
