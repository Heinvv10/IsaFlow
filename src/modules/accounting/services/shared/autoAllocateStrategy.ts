/**
 * The per-contact instruction for what to do with cash that arrives without an
 * invoice named on it.
 *
 * THE SETTING THAT NEVER EXISTED. `suppliers.auto_allocate_payments` and
 * `customers.auto_allocate_receipts` (migration 246) were written by the
 * forms, the REST routes and the MCP contact tools, and read by NOTHING. The
 * supplier toggle read "Auto Allocate Payments to Oldest Invoice"; the only
 * code that ever chose an invoice for a bank allocation ordered by
 * `created_at DESC` — the NEWEST bill — and then set a `payment_matched`
 * boolean on it without moving `amount_paid` by a cent. The screen said
 * oldest, the code did newest, and neither applied any cash.
 *
 * A boolean cannot carry that choice, so migration 614 replaces it with a
 * strategy and this module owns the vocabulary. 'off' is the default and the
 * conservative one: the payment document is still created — that is what makes
 * the cash visible to `list_unapplied_payments` and reachable by
 * `apply_supplier_payment` — but nothing is applied to a document nobody named.
 *
 * The arithmetic lives here, pure, because the AP and AR halves must consume
 * cash identically. Two greedy loops that drifted by a cent would put the two
 * subledgers on different rules for the same instruction.
 */

/** A cent. Money comparisons are made at this tolerance, never exactly. */
export const EPS = 0.01;

export const AUTO_ALLOCATE_STRATEGIES = ['off', 'oldest', 'newest'] as const;
export type AutoAllocateStrategy = (typeof AUTO_ALLOCATE_STRATEGIES)[number];

/**
 * A value from a request or a database column, or null when it is not one of
 * the three. Callers refuse on null rather than coercing: a typo'd strategy
 * that silently became 'off' would report success while applying nothing.
 */
export function parseAutoAllocateStrategy(value: unknown): AutoAllocateStrategy | null {
  return typeof value === 'string'
    && (AUTO_ALLOCATE_STRATEGIES as readonly string[]).includes(value)
    ? value as AutoAllocateStrategy
    : null;
}

/** How a strategy orders the open documents it consumes. */
export function strategyOrdersOldestFirst(strategy: AutoAllocateStrategy): boolean {
  return strategy === 'oldest';
}

/** One open document the cash can be applied to, in the order it should be. */
export interface OpenDocument {
  invoiceId: string;
  outstanding: number;
}

export interface PlannedAllocation {
  invoiceId: string;
  amount: number;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Consume `cash` across `documents` IN THE ORDER GIVEN, settling each in full
 * until the money runs out and PARTIALLY settling the one it runs out on.
 *
 * Partial settlement is the point rather than an edge case. Refusing to part-pay
 * would leave a R10,000 payment against a R15,000 oldest bill applying nothing
 * at all — the money would sit unapplied while the bill it obviously paid aged
 * another month, which is the state this whole change exists to end.
 *
 * Returns fewer lines than documents when the cash runs out first, and an EMPTY
 * array when there is nothing open to apply to. An empty result is a normal
 * outcome, not a failure: the payment stays wholly unapplied and
 * `list_unapplied_payments` reports it.
 *
 * Documents at or under a cent outstanding are skipped, as is a line the
 * remaining cash rounds to nothing on: a fractional cent is rounding rather
 * than a settlement.
 */
export function planGreedyAllocations(
  cash: number,
  documents: readonly OpenDocument[],
): PlannedAllocation[] {
  const out: PlannedAllocation[] = [];
  let remaining = round2(cash);
  for (const doc of documents) {
    // An early exit only — the `amount <= EPS` test below is the gate that
    // actually decides, and it covers an exhausted balance too. Kept so a
    // supplier with hundreds of open bills is not walked after the money is
    // gone.
    if (remaining <= EPS) break;
    const amount = round2(Math.min(remaining, round2(doc.outstanding)));
    // Skips both a document with nothing left on it and a line that rounds to
    // nothing. `payment_allocations` carries CHECK (amount_allocated > 0), so a
    // zero line raises 23514 halfway through the write rather than refusing.
    if (amount <= EPS) continue;
    out.push({ invoiceId: doc.invoiceId, amount });
    remaining = round2(remaining - amount);
  }
  return out;
}
