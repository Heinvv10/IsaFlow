/**
 * The month amounts of a budget: the even spread and the refusal of a split
 * that is not exactly the year's months.
 */
import { describe, it, expect } from 'vitest';
import { BudgetInputError, resolveMonthAmounts, spreadEvenly } from '@/modules/accounting/services/core/budgetMonths';

const KEYS_14 = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07',
  '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02'];

describe('spreadEvenly', () => {
  it('puts the cents on the last month so the months sum to the annual', () => {
    const parts = spreadEvenly(100000, 12);
    expect(parts.slice(0, 11)).toEqual(Array<number>(11).fill(8333.33));
    expect(parts[11]).toBe(8333.37);
    expect(Math.round(parts.reduce((s, p) => s + p, 0) * 100) / 100).toBe(100000);
  });

  it('spreads over 14 months', () => {
    const parts = spreadEvenly(100000, 14);
    expect(parts).toHaveLength(14);
    expect(parts[0]).toBe(7142.86);
    expect(parts[13]).toBe(7142.82);
  });

  it('one month carries the whole amount', () => {
    expect(spreadEvenly(500, 1)).toEqual([500]);
  });
});

describe('resolveMonthAmounts', () => {
  it('honours an explicit split, in the year\'s order whatever order it arrives in', () => {
    const given = [...KEYS_14].reverse().map((month, i) => ({ month, amount: i }));
    const out = resolveMonthAmounts(KEYS_14, { months: given });
    expect(out.map(m => m.month)).toEqual(KEYS_14);
    expect(out[13]).toEqual({ month: '2027-02', amount: 0 });
    expect(out[0]).toEqual({ month: '2026-01', amount: 13 });
  });

  it('prefers the explicit split to an annual amount', () => {
    const out = resolveMonthAmounts(['2026-01', '2026-02'], {
      months: [{ month: '2026-01', amount: 1 }, { month: '2026-02', amount: 2 }], annualAmount: 999,
    });
    expect(out.map(m => m.amount)).toEqual([1, 2]);
  });

  it('refuses a missing month, a month of another year, a duplicate and a non-number', () => {
    const keys = ['2026-01', '2026-02'];
    expect(() => resolveMonthAmounts(keys, { months: [{ month: '2026-01', amount: 1 }] })).toThrow(/missing 2026-02/);
    expect(() => resolveMonthAmounts(keys, { months: [{ month: '2026-01', amount: 1 }, { month: '2026-02', amount: 1 }, { month: '2026-03', amount: 1 }] }))
      .toThrow(/not in this year: 2026-03/);
    expect(() => resolveMonthAmounts(keys, { months: [{ month: '2026-01', amount: 1 }, { month: '2026-01', amount: 1 }] }))
      .toThrow(/given twice/);
    expect(() => resolveMonthAmounts(keys, { months: [{ month: '2026-01', amount: Number.NaN }, { month: '2026-02', amount: 1 }] }))
      .toThrow(BudgetInputError);
  });

  it('refuses neither months nor an annual amount', () => {
    expect(() => resolveMonthAmounts(['2026-01'], {})).toThrow(BudgetInputError);
  });
});
