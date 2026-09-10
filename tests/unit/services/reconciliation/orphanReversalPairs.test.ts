/**
 * K-053 round 12 (MEDIUM-1) — the pairing must be a property of the CHAIN, not
 * of the order the rows arrive in.
 *
 * `getUnappliedControlCash` orders its candidates `ORDER BY je.entry_date,
 * je.id`, and every delete reversal is dated TODAY, so within one document a
 * random UUID decides the order. After delete -> undo -> delete -> undo the
 * chain is O <- R <- R2 <- R3 <- R4; a pass that pairs greedily in row order
 * pairs R3 with R2 when R3 comes first and leaves R and R4 standing, which puts
 * the document's full gross value back on the reconciler twice.
 *
 * The orderings below are fed explicitly rather than shuffled, so each case is
 * a fixed input with a fixed answer and the RED is not a coin flip.
 */
import { describe, expect, it } from 'vitest';
import type { DbRow } from '@/lib/neon';
import { dropCancelledReversalPairs } from '@/modules/accounting/services/reconciliation/orphanReversalPairs';

const GROSS = 1150;

/** A candidate row in the shape `unappliedCashService` selects. */
function row(id: string, reversalOf: string | null, controlCredit: number): DbRow {
  return { id, reversal_of_id: reversalOf, control_credit: controlCredit } as unknown as DbRow;
}

/**
 * The candidates of a document deleted and restored `cycles` times. `O` is the
 * approval journal, which the invoice still points at and which is therefore
 * NOT a candidate. Each cycle adds a delete reversal (credit, netting the
 * debtor away) and an undo reversal (debit, putting it back).
 */
function chain(cycles: number): DbRow[] {
  const out: DbRow[] = [];
  let previous = 'O';
  for (let i = 0; i < cycles * 2; i += 1) {
    const id = `R${i + 1}`;
    out.push(row(id, previous, i % 2 === 0 ? -GROSS : GROSS));
    previous = id;
  }
  return out;
}

const ids = (rows: readonly DbRow[]): string[] => rows.map((r) => String(r.id));

describe('dropCancelledReversalPairs — the chain decides, not the row order', () => {
  it('one round trip: both legs drop, in any of the two orders', () => {
    const [r1, r2] = chain(1) as [DbRow, DbRow];
    expect(dropCancelledReversalPairs([r1, r2])).toEqual([]);
    expect(dropCancelledReversalPairs([r2, r1])).toEqual([]);
  });

  it('TWO round trips: all four legs drop, whichever link sorts first', () => {
    const [r1, r2, r3, r4] = chain(2) as [DbRow, DbRow, DbRow, DbRow];
    // The order that broke the greedy pass: R3 first, so it paired with R2 and
    // left R1 and R4 reported for GROSS each.
    expect(dropCancelledReversalPairs([r3, r2, r4, r1])).toEqual([]);
    expect(dropCancelledReversalPairs([r1, r2, r3, r4])).toEqual([]);
    expect(dropCancelledReversalPairs([r4, r3, r2, r1])).toEqual([]);
    expect(dropCancelledReversalPairs([r2, r4, r1, r3])).toEqual([]);
  });

  it('THREE round trips: all six legs drop, in every rotation of the chain', () => {
    const six = chain(3);
    for (let start = 0; start < six.length; start += 1) {
      const rotated = [...six.slice(start), ...six.slice(0, start)];
      expect(dropCancelledReversalPairs(rotated)).toEqual([]);
    }
  });

  it('a delete still pending after two round trips leaves exactly its own leg', () => {
    // O <- R1 <- R2 <- R3: deleted, undone, deleted again and not yet restored.
    const [r1, r2, r3] = chain(2).slice(0, 3) as [DbRow, DbRow, DbRow];
    expect(ids(dropCancelledReversalPairs([r3, r1, r2]))).toEqual(['R3']);
    expect(ids(dropCancelledReversalPairs([r1, r2, r3]))).toEqual(['R3']);
  });

  it('a lone manual reversal of a live document is never dropped', () => {
    const manual = row('M', 'O', -GROSS);
    expect(ids(dropCancelledReversalPairs([manual]))).toEqual(['M']);
  });

  it('an as-at date that sees only the first leg keeps it', () => {
    const [r1] = chain(1) as [DbRow, DbRow];
    expect(ids(dropCancelledReversalPairs([r1]))).toEqual(['R1']);
  });

  it('amounts that do not cancel are left alone, and do not derail the rest', () => {
    // R1/R2 is a partial correction; R3/R4 behind it still cancels exactly.
    const [r1, , r3, r4] = chain(2) as [DbRow, DbRow, DbRow, DbRow];
    const partial = row('R2', 'R1', GROSS - 100);
    expect(ids(dropCancelledReversalPairs([r3, partial, r4, r1]))).toEqual(['R2', 'R1']);
  });

  it('a chain whose head is a genuine orphan leaves exactly one item', () => {
    // A <- B <- C, all three unclaimed: A/B cancel, C stands for its own value.
    const a = row('A', 'X', -GROSS);
    const b = row('B', 'A', GROSS);
    const c = row('C', 'B', -GROSS);
    expect(ids(dropCancelledReversalPairs([c, b, a]))).toEqual(['C']);
  });

  it('a self-referencing row cannot spin the walk', () => {
    const loop = row('L', 'L', -GROSS);
    expect(ids(dropCancelledReversalPairs([loop]))).toEqual(['L']);
  });

  it('rows with no reversal_of_id at all are returned untouched', () => {
    const bare = [row('P', null, -500), row('Q', null, -700)];
    expect(dropCancelledReversalPairs(bare)).toEqual(bare);
  });
});
