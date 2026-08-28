/**
 * PRD-11 §4 — which lines of a batch can actually post.
 *
 * A batch is a set an agent assembled from a statement, not a hand-checked
 * list: some of its rows have usually been allocated already (by the UI, by an
 * earlier batch, by the same agent yesterday). PRD §4 makes that the NORMAL
 * case — those lines are SKIPPED, counted and reported, never re-posted and
 * never fatal.
 *
 * Before this existed the batch found out from inside `allocateTransaction`,
 * which throws `Transaction already allocated — cannot allocate` AFTER its row
 * lock. A throw is the right shape for a fault (the registry savepoint unwinds
 * the batch) and the wrong shape for a row that simply has nothing left to do:
 * a 124-line pilot batch with one allocated row failed whole, told the agent
 * only "the operation failed", and was bisected by hand.
 *
 * READ-ONLY, and deliberately on the pre-write side of the tool: the split
 * between "refused before anything was written" and "must throw so the batch
 * unwinds" is the safety boundary the whole file layout is built around.
 */
import type { BankTransactionAllocationState } from '@/modules/accounting/services/bank/bankTransactionLookupService';
import { findBankTransactionAllocationStates } from '@/modules/accounting/services/bank/bankTransactionLookupService';
import type { ResolvedLine } from './bulkAllocationPrepare';
import { NOT_FOUND } from './toolHelpers';

export interface SkippedLine {
  /** Index into the caller's own `allocations` array. */
  index: number;
  transaction_id: string;
  reason: string;
}

/** The one reason string every skip path uses for an allocated row. */
export const ALREADY_ALLOCATED = 'already allocated';

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
  if (state.status === 'imported' && state.matchedJournalLineId === null) return null;
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

export interface Partitioned {
  postable: ResolvedLine[];
  skipped: SkippedLine[];
}

/**
 * Splits the resolved lines into what will post and what will not.
 *
 * Returns the refusal TEXT instead when a line names a row this company does
 * not have. That is a pre-write refusal, not a skip: a batch quietly reporting
 * "skipped: not found" would let an agent's typo look like routine housekeeping
 * forever. The wording is the shared NOT_FOUND — the index says which line, the
 * text never says whether the row exists in some other tenant.
 */
export async function partitionAllocationLines(
  companyId: string,
  resolved: readonly ResolvedLine[],
): Promise<Partitioned | string> {
  // ONE query for the whole batch. Per-line reads would be 500 round trips
  // inside a request that is about to take 500 row locks.
  const states = await findBankTransactionAllocationStates(
    companyId,
    resolved.map((r) => r.txId),
  );

  const postable: ResolvedLine[] = [];
  const skipped: SkippedLine[] = [];
  const missing: string[] = [];
  for (const line of resolved) {
    const state = states.get(line.txId);
    if (!state) {
      missing.push(`allocations[${line.index}]: ${NOT_FOUND}`);
      continue;
    }
    const reason = skipReasonFor(state);
    if (reason === null) postable.push(line);
    else skipped.push({ index: line.index, transaction_id: line.txId, reason });
  }
  if (missing.length > 0) return missing.join(' | ');
  return { postable, skipped };
}

/** The refusal for a batch where every line was skipped. */
export function nothingToPostText(skipped: readonly SkippedLine[]): string {
  const listed = skipped
    .slice(0, 20)
    .map((s) => `allocations[${s.index}] (${s.transaction_id}): ${s.reason}`)
    .join(' | ');
  const more = skipped.length - Math.min(skipped.length, 20);
  return `nothing to post: all ${skipped.length} lines skipped — ${listed}`
    + (more > 0 ? ` | …and ${more} more` : '');
}
