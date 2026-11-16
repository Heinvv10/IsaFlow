/**
 * THE bucket of a bank statement line (WP1 "Truthful numbers", 2026-11-15): the one definition behind the bank
 * card's counts (`bankAccountSummarySql`), the list's `allocationFilter` (`allocationCond`) and the MCP
 * `list_bank_transactions` allocation state and `group_by=allocation` (`bankTxSummaryService`, `lineBucketOf`).
 *
 * First arm that holds wins, so the buckets are disjoint and every posted line lands in exactly one:
 *   - pending     — not posted at the bank yet (`feed_state` pending; removed rows too, for callers that do not
 *                   drop them). Over posted lines this arm never fires.
 *   - excluded    — status 'excluded', checked FIRST: exclude keeps a line's match, and such a line used to be
 *                   counted in both Allocated and Excluded.
 *   - allocated   — a journal books the line's cash: a matched journal line, or a status that only a booked line
 *                   carries. 'provisional' (its provisional journal is posted; allocate refuses it) and 'reconciled'
 *                   without a matched line (the Sage import) count here; both used to land in Unallocated.
 *   - suggested   — no journal yet, but a suggestion or a saved category (allocation_type).
 *   - unallocated — none of the above. `status` is nullable (migration 203), and a NULL status falls through to
 *                   suggested / unallocated like 'imported' (SQL: NULL = 'excluded' is not true; JS: mapTxRow
 *                   renders it 'null', which equals none of the literals).
 *
 * `toCode = suggested + unallocated`.
 *
 * A fixed literal over the alias `bt` — nothing is interpolated — so it is safe for `sql.unsafe`. `lineBucketOf` is
 * its JS mirror, same precedence; the partition integration suite checks the two agree row by row.
 */
import type { BankTransaction } from '../../types/bank.types';

export type LineBucket = 'pending' | 'excluded' | 'allocated' | 'suggested' | 'unallocated';

export const LINE_BUCKET_SQL = `CASE
  WHEN bt.feed_state <> 'posted' THEN 'pending'
  WHEN bt.status = 'excluded' THEN 'excluded'
  WHEN bt.matched_journal_line_id IS NOT NULL
    OR bt.status IN ('allocated', 'matched', 'reconciled', 'provisional') THEN 'allocated'
  WHEN (bt.suggested_gl_account_id IS NOT NULL OR bt.suggested_supplier_id IS NOT NULL
        OR bt.suggested_client_id IS NOT NULL OR bt.allocation_type IS NOT NULL) THEN 'suggested'
  ELSE 'unallocated'
END`;

const BOOKED_STATUSES: readonly string[] = ['allocated', 'matched', 'reconciled', 'provisional'];

export type LineBucketFields = Pick<BankTransaction,
  'feedState' | 'status' | 'matchedJournalLineId' | 'suggestedGlAccountId' | 'suggestedSupplierId'
  | 'suggestedClientId' | 'allocationType'>;

/** JS mirror of LINE_BUCKET_SQL, for a mapped row (`mapTxRow`). */
export function lineBucketOf(tx: LineBucketFields): LineBucket {
  if (tx.feedState !== 'posted') return 'pending';
  const status = String(tx.status);
  if (status === 'excluded') return 'excluded';
  if (tx.matchedJournalLineId || BOOKED_STATUSES.includes(status)) return 'allocated';
  if (tx.suggestedGlAccountId || tx.suggestedSupplierId || tx.suggestedClientId || tx.allocationType) {
    return 'suggested';
  }
  return 'unallocated';
}
