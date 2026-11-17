/**
 * The row-state half of PRD-11 §4 (moved out of bulkAllocationSkip.ts for its line cap, unchanged): the reason a
 * bulk line's ROW cannot post, shared with the posting loop's race mapping (bulkAllocationPost).
 */
import type { BankTransactionAllocationState } from '@/modules/accounting/services/bank/bankTransactionLookupService';

export interface SkippedLine {
  /** Index into the caller's own `allocations` array. */
  index: number;
  /**
   * NULL when the line's selector never resolved to a row — an unrecognised or
   * ambiguous `bank_reference`. The index still names the line, so the agent
   * can always find it; there is simply no id to report, and inventing one
   * (echoing the reference back in this field) would read as a transaction.
   */
  transaction_id: string | null;
  reason: string;
}

/** The one reason string every skip path uses for an allocated row. */
export const ALREADY_ALLOCATED = 'already allocated';

/**
 * A R0.00 statement line (a waived fee, a bank memo line). It has no money to move and so no journal to post:
 * `createJournalEntry` refuses a line with no debit or credit, which rolled back the whole batch beside it. Skipped
 * like any other row-state fact; the row stays 'imported' for a person to exclude or leave.
 */
export const ZERO_AMOUNT = 'zero_amount';

/** The statuses that mean the transaction is already represented in the ledger. */
const ALLOCATED_STATUSES: readonly string[] = ['allocated', 'reconciled', 'matched'];

/**
 * The reason text for a row sitting in `status`, with no other information.
 *
 * Shared with the POSTING loop, which learns a raced row's status only from
 * `allocateTransaction`'s refusal message. Deriving both from one mapping is
 * what keeps the two paths honest: reporting every race as "already allocated"
 * told an agent its excluded transaction had been booked.
 */
export function reasonForStatus(status: string): string {
  // Excluded is its own answer, not a flavour of "already allocated": it says a
  // person deliberately took this transaction out of the books.
  if (status === 'excluded') return 'excluded';
  if (ALLOCATED_STATUSES.includes(status)) return ALREADY_ALLOCATED;
  // Anything else is reported with the status VERBATIM rather than flattened
  // into a reason the agent cannot act on.
  return `not importable: ${status}`;
}

/**
 * Why this row cannot post, or `null` when it can.
 *
 * Postable is the narrow definition `allocateTransaction` itself enforces —
 * `status='imported'` — PLUS "carries no journal". The journal check is not
 * redundant: `matched_journal_line_id` is what `reverse_bank_allocation_batch`
 * navigates by, and a row holding one is already represented in the ledger
 * whatever its status column says. Reading only `status` is the mistake that
 * passed a fixture and let the #261 batch through.
 */
export function skipReasonFor(state: BankTransactionAllocationState): string | null {
  // First: a non-posted feed row is refused by allocateTransaction mid-batch,
  // which would unwind every good line beside it (A-4).
  if (state.feedState === 'pending') return 'pending at the bank';
  if (state.feedState === 'removed') return 'removed by the bank';
  // After the feed-state checks and BEFORE the row is declared postable; a zero row that is also allocated or
  // excluded keeps the more informative reason below.
  if (state.status === 'imported' && state.matchedJournalLineId === null) {
    return state.amount === 0 ? ZERO_AMOUNT : null;
  }
  if (state.matchedJournalLineId !== null) {
    // An excluded row that ALSO carries a journal is a contradiction someone
    // needs to see: it is in the ledger and marked as kept out of it. Reporting
    // only "excluded" hides the posting; reporting only "already allocated"
    // hides that a person excluded it. Both facts, in one reason.
    return state.status === 'excluded'
      ? `${ALREADY_ALLOCATED} (excluded)`
      : ALREADY_ALLOCATED;
  }
  return reasonForStatus(state.status);
}
