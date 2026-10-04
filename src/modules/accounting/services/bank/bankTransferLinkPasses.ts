/**
 * bankTransferLinkPasses — the repeat-until-settled runner both transfer link
 * passes in bankTransferLinkService share.
 *
 * Split from the queries because it is a different concern: the savepoint that
 * keeps a swallowed failure from aborting the request transaction, and the loop
 * that lets a beaten runner-up reach its second-best line.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { lockBankTransactionsInIdOrder } from './bankTxLock';
import { shareLockChainHeadOf } from '../shared/journalChainHead';
import { journalStandsUnbrokenFragment } from '../shared/journalInForceAsAt';

export type Row = Record<string, unknown>;

/**
 * Outcome of a link pass. `failed` distinguishes "nothing to link" from "the
 * pass errored": both used to return 0, so a caller (and the UI behind
 * `bank-relink-transfers`) could not tell them apart.
 */
export interface TransferLinkResult {
  linked: number;
  /**
   * Statements the pass ran that linked something. One means the rank pairing
   * settled every contender in a single statement; more means a partial overlap
   * needed a second look. Reported so a regression to one-row-per-pass is
   * visible in the log and assertable in a test.
   */
  passes: number;
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
      if (linked > 0) log.info(label, { ...context, linked, passes }, 'accounting');
      return { linked, passes, failed: false };
    });
  } catch (err) {
    log.warn(`${label} failed — non-fatal`, { ...context, error: err }, 'accounting');
    return { linked: 0, passes: 0, failed: true };
  }
}

/** One pairing a pass chose: the imported line and the free counterpart line of an existing transfer journal. */
export interface TransferLinkPair {
  new_tx_id: string; je_id: string; je_line_id: string; counterparty_bank_id: string; entity_name: string | null;
}

/**
 * Apply a pass's pairings (D12 round 4, brk-d12 R3-1): a link ties a statement line to an EXISTING journal, so — as a
 * match does — the lines are locked first (their sessions first, `lockBankTransactionsInIdOrder`), then each target
 * journal's chain HEAD FOR SHARE (`shareLockChainHeadOf`, 5 s → 503); a reversal in flight on that chain is waited for,
 * and the UPDATE re-reads under those locks that the journal still stands. Bank line -> journal head, the one order.
 * `transfer_journal_entry_id` is set alongside the line: the duplicate-transfer guard in bankAllocationService selects
 * on it, so a linked row without it is invisible to that guard.
 */
export async function applyTransferLinks(companyId: string, pairs: TransferLinkPair[]): Promise<Row[]> {
  if (pairs.length === 0) return [];
  await lockBankTransactionsInIdOrder(companyId, pairs.map((p) => p.new_tx_id));
  for (const je of [...new Set(pairs.map((p) => String(p.je_id)))].sort()) await shareLockChainHeadOf(companyId, je);
  return (await sql`
    UPDATE bank_transactions bt
    SET status                    = 'allocated',
        allocation_type           = 'transfer',
        transfer_journal_entry_id = m.je_id,
        matched_journal_line_id   = m.je_line_id,
        counterparty_account_id   = m.counterparty_bank_id,
        allocated_entity_name     = m.entity_name,
        -- Redundant today (the WHERE is status='imported', which a rule-posted row can never be) but keeps every
        -- writer of allocated_entity_name symmetrical.
        allocation_rule_id = NULL, allocation_rule_name = NULL,
        updated_at                = NOW()
    FROM jsonb_to_recordset(${JSON.stringify(pairs)}::JSONB)
      AS m(new_tx_id UUID, je_id UUID, je_line_id UUID, counterparty_bank_id UUID, entity_name TEXT)
    JOIN gl_journal_entries je ON je.id = m.je_id AND je.company_id = ${companyId}::UUID
    WHERE bt.id         = m.new_tx_id
      AND bt.company_id = ${companyId}::UUID
      AND bt.status     = 'imported'
      AND bt.feed_state = 'posted'
      AND je.status     = 'posted' AND ${journalStandsUnbrokenFragment('je.id', companyId)}
      AND NOT EXISTS (SELECT 1 FROM bank_transactions u
        WHERE u.company_id = ${companyId}::UUID AND u.matched_journal_line_id = m.je_line_id)
    RETURNING bt.id`) as Row[];
}
