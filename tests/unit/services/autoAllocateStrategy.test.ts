/**
 * The pure half of auto-allocation: how cash is consumed across open documents.
 *
 * Pure on purpose — the AP and AR halves share this function precisely so the
 * two subledgers cannot drift on the same instruction. Every case here is a
 * fact about money, not about SQL.
 */
import { describe, it, expect } from 'vitest';
import {
  parseAutoAllocateStrategy,
  planGreedyAllocations,
  strategyOrdersOldestFirst,
} from '@/modules/accounting/services/shared/autoAllocateStrategy';

describe('parseAutoAllocateStrategy', () => {
  it('accepts the three strategies and nothing else', () => {
    expect(parseAutoAllocateStrategy('off')).toBe('off');
    expect(parseAutoAllocateStrategy('oldest')).toBe('oldest');
    expect(parseAutoAllocateStrategy('newest')).toBe('newest');
  });

  it('returns null rather than coercing an unknown value', () => {
    // A typo that silently became 'off' would report success while applying
    // nothing; one that silently became 'oldest' would apply cash nobody asked
    // it to. Both are worse than a refusal.
    expect(parseAutoAllocateStrategy('fifo')).toBeNull();
    expect(parseAutoAllocateStrategy('OLDEST')).toBeNull();
    expect(parseAutoAllocateStrategy('')).toBeNull();
    expect(parseAutoAllocateStrategy(true)).toBeNull();
    expect(parseAutoAllocateStrategy(null)).toBeNull();
    expect(parseAutoAllocateStrategy(undefined)).toBeNull();
  });

  it('orders oldest-first for "oldest" only', () => {
    expect(strategyOrdersOldestFirst('oldest')).toBe(true);
    expect(strategyOrdersOldestFirst('newest')).toBe(false);
    expect(strategyOrdersOldestFirst('off')).toBe(false);
  });
});

describe('planGreedyAllocations', () => {
  it('settles documents in the order given until the cash runs out', () => {
    const lines = planGreedyAllocations(1000, [
      { invoiceId: 'a', outstanding: 400 },
      { invoiceId: 'b', outstanding: 300 },
      { invoiceId: 'c', outstanding: 500 },
    ]);
    expect(lines).toEqual([
      { invoiceId: 'a', amount: 400 },
      { invoiceId: 'b', amount: 300 },
      { invoiceId: 'c', amount: 300 },
    ]);
  });

  it('PARTIALLY settles the document the money runs out on', () => {
    // The case the old behaviour got wrong by refusing to part-pay: R10,000
    // against a R15,000 oldest bill must apply R10,000, not nothing.
    expect(planGreedyAllocations(10000, [{ invoiceId: 'a', outstanding: 15000 }]))
      .toEqual([{ invoiceId: 'a', amount: 10000 }]);
  });

  it('never allocates more than the cash received', () => {
    const lines = planGreedyAllocations(500, [
      { invoiceId: 'a', outstanding: 400 },
      { invoiceId: 'b', outstanding: 400 },
    ]);
    expect(lines.reduce((s, l) => s + l.amount, 0)).toBeCloseTo(500, 2);
  });

  it('never allocates more to a document than it has outstanding', () => {
    const lines = planGreedyAllocations(1000, [{ invoiceId: 'a', outstanding: 250 }]);
    expect(lines).toEqual([{ invoiceId: 'a', amount: 250 }]);
  });

  it('stops at the last document rather than inventing one', () => {
    const lines = planGreedyAllocations(900, [{ invoiceId: 'a', outstanding: 400 }]);
    expect(lines).toHaveLength(1);
  });

  it('returns nothing when there is nothing open — a normal outcome', () => {
    expect(planGreedyAllocations(5000, [])).toEqual([]);
  });

  it('skips a document with a cent or less outstanding', () => {
    // payment_allocations carries CHECK (amount_allocated > 0): a zero line
    // would raise 23514 halfway through the write.
    const lines = planGreedyAllocations(100, [
      { invoiceId: 'rounding', outstanding: 0.004 },
      { invoiceId: 'real', outstanding: 50 },
    ]);
    expect(lines).toEqual([{ invoiceId: 'real', amount: 50 }]);
  });

  it('allocates nothing when the cash is a cent or less', () => {
    expect(planGreedyAllocations(0.004, [{ invoiceId: 'a', outstanding: 50 }])).toEqual([]);
  });

  it('rounds to the cent so the lines sum to the cash exactly', () => {
    const lines = planGreedyAllocations(100.005, [
      { invoiceId: 'a', outstanding: 33.333 },
      { invoiceId: 'b', outstanding: 1000 },
    ]);
    const total = lines.reduce((s, l) => s + l.amount, 0);
    expect(Number(total.toFixed(2))).toBeCloseTo(100.01, 2);
    for (const l of lines) expect(l.amount).toBe(Number(l.amount.toFixed(2)));
  });
});
