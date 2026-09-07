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
import {
  applyRouteFor,
  fetchInvoiceStates,
  signMismatchReason,
  skipReasonForInvoice,
  type ApplyKind,
} from './allocationApplyRoute';
import { NOT_FOUND } from './toolHelpers';

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
 * A line naming a row this company does not have is SKIPPED, like every other
 * row-state fact. It used to refuse the whole batch, on the reasoning that a
 * quiet "skipped: not found" lets an agent's typo look like routine
 * housekeeping — but the cost of that was a 500-line batch posting nothing over
 * one stale id, which the agent could only locate by bisecting. What actually
 * protects against the silent-typo case is the caller's `nothingToPostText`
 * refusal: a batch where nothing at all resolves is still loud.
 *
 * The wording stays the shared NOT_FOUND: the index says which line, the text
 * never says whether the row exists in some other tenant. A row that vanished
 * between `resolveTxSelectors` and this read (undo_bank_import, a manual
 * delete) reads the same, which is correct — it is equally gone.
 */
export async function partitionAllocationLines(
  companyId: string,
  resolved: readonly ResolvedLine[],
): Promise<Partitioned> {
  // ONE query for the whole batch. Per-line reads would be 500 round trips
  // inside a request that is about to take 500 row locks.
  const states = await findBankTransactionAllocationStates(
    companyId,
    resolved.map((r) => r.txId),
  );

  const postable: ResolvedLine[] = [];
  const skipped: SkippedLine[] = [];
  // Lines that cleared the row-state check, carried with the bank amount so
  // the invoice check below needs no further reads.
  // The SIGNED amount rides along beside the absolute one: the invoice checks
  // want the magnitude, the direction check below wants the sign, and re-reading
  // the row to recover it would put a second query on the hot path.
  const candidates: { line: ResolvedLine; amount: number; signed: number }[] = [];
  for (const line of resolved) {
    const state = states.get(line.txId);
    // The id resolved but names no row this company has. Reported WITH the id
    // the caller sent — unlike an unresolved reference there is one, and it is
    // what the agent needs to correct its list.
    if (!state) {
      skipped.push({ index: line.index, transaction_id: line.txId, reason: NOT_FOUND });
      continue;
    }
    const reason = skipReasonFor(state);
    if (reason !== null) {
      skipped.push({ index: line.index, transaction_id: line.txId, reason });
      continue;
    }
    candidates.push({ line, amount: Math.abs(state.amount), signed: state.amount });
  }

  // Second pass: the invoice a line names may itself be settled, cancelled or
  // too small for the amount. Those are DATA facts, like every other skip here
  // — `receiptAllocationLines` would raise them mid-write, which in a batch
  // means one stale invoice unwinds every good line beside it. Hoisted to a
  // read so the batch skips around them, and because this runs before the
  // first write it is also what `dry_run` reports.
  const refs = candidates
    .map(({ line }) => {
      const kind = applyRouteFor(line.line.allocType, line.line.invoiceId);
      return kind && line.line.invoiceId ? { kind, invoiceId: line.line.invoiceId } : null;
    })
    .filter((r): r is { kind: ApplyKind; invoiceId: string } => r !== null);
  const invoiceStates = refs.length > 0
    ? await fetchInvoiceStates(companyId, refs)
    : new Map();

  // CUMULATIVE, not per line against one snapshot. `fetchInvoiceStates` is read
  // once, before anything writes, so two lines naming the SAME invoice were
  // each measured against the same untouched balance: a pair that fits
  // individually but not together was classified postable and `dry_run` agreed.
  // Live, the first posted, the second threw inside `receiptAllocationLines`
  // mid-write, and that throw unwinds the registry's OUTER savepoint — silently
  // reverting every already-successful line in the batch. That is the exact
  // outcome this file exists to prevent, triggered inside one call rather than
  // five minutes apart. `bulkAllocationPrepare` already refuses a duplicate
  // transaction_id for the same reason; this is its invoice-shaped twin.
  //
  // Lines are walked in the caller's order, so the line that keeps the balance
  // is the earlier one and the reason can name it.
  const committed = new Map<string, number>();
  const claimedBy = new Map<string, number>();

  for (const { line, amount, signed } of candidates) {
    const kind = applyRouteFor(line.line.allocType, line.line.invoiceId);
    const invoiceId = line.line.invoiceId;
    if (kind === null || !invoiceId) {
      postable.push(line);
      continue;
    }

    // BEFORE the balance check, and that order is load-bearing twice over: a
    // line pointing the wrong way must not consume any of `committed`, or a
    // later good line against the same invoice is skipped for a balance an
    // impossible line claimed; and the reason it gets told has to be the sign,
    // not "exceeds the outstanding", which sends the agent to fix a number.
    //
    // A SKIP rather than the single tool's refusal, on this file's standing
    // rule: one contradictory line in a 500-line batch must not unwind 499 that
    // are correct. `postAndApplyLine` raises the identical text as a
    // BankLineDirectionError for the single-line tools.
    const wrongWay = signMismatchReason(kind, signed);
    if (wrongWay !== null) {
      skipped.push({ index: line.index, transaction_id: line.txId, reason: wrongWay });
      continue;
    }

    const state = invoiceStates.get(invoiceId);
    const already = committed.get(invoiceId) ?? 0;
    // What this line actually faces: the snapshot less what earlier lines in
    // THIS batch have already claimed against the same invoice.
    const remaining = state === undefined
      ? state
      : { ...state, outstanding: Math.round((state.outstanding - already) * 100) / 100 };

    const reason = skipReasonForInvoice(remaining, invoiceId, amount);
    if (reason === null) {
      postable.push(line);
      committed.set(invoiceId, Math.round((already + amount) * 100) / 100);
      if (!claimedBy.has(invoiceId)) claimedBy.set(invoiceId, line.index);
      continue;
    }

    // Say WHICH earlier line consumed the balance. Without it the agent reads
    // "exceeds the outstanding" about an invoice that looked wholly open in the
    // payload it just sent, and has no way to see why.
    const priorIndex = already > 0 ? claimedBy.get(invoiceId) : undefined;
    skipped.push({
      index: line.index,
      transaction_id: line.txId,
      reason: priorIndex === undefined
        ? reason
        : `${reason} (allocations[${priorIndex}] in this call already claims `
          + `R${already.toFixed(2)} of it)`,
    });
  }

  return { postable, skipped };
}

/** The refusal for a batch where every line was skipped. */
export function nothingToPostText(skipped: readonly SkippedLine[]): string {
  const listed = skipped
    .slice(0, 20)
    .map((s) => (s.transaction_id === null
      ? `allocations[${s.index}]: ${s.reason}`
      : `allocations[${s.index}] (${s.transaction_id}): ${s.reason}`))
    .join(' | ');
  const more = skipped.length - Math.min(skipped.length, 20);
  return `nothing to post: all ${skipped.length} lines skipped — ${listed}`
    + (more > 0 ? ` | …and ${more} more` : '');
}
