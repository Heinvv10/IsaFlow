/**
 * The month amounts of a budget: the even spread and the refusal of a split
 * that is not exactly the year's months.
 */
import { describe, it, expect } from 'vitest';
import { BudgetInputError, resolveMonthAmounts, round2, spreadEvenly } from '@/modules/accounting/services/core/budgetMonths';

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

  it('zero spreads as zeros', () => {
    expect(spreadEvenly(0, 14)).toEqual(Array<number>(14).fill(0));
  });

  it('a negative annual (a credit budget) spreads with the cents on the last month', () => {
    expect(spreadEvenly(-100, 3)).toEqual([-33.33, -33.33, -33.34]);
  });

  it('15 months, the longest a transition year can be, sum back to the annual', () => {
    const parts = spreadEvenly(1000, 15);
    expect(parts).toHaveLength(15);
    expect(parts[0]).toBe(66.67);
    expect(parts[14]).toBe(66.62);
    expect(Math.round(parts.reduce((s, p) => s + p, 0) * 100) / 100).toBe(1000);
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

  it('annualAmount 0 stores a zero for every month, not nothing', () => {
    const out = resolveMonthAmounts(['2026-01', '2026-02'], { annualAmount: 0 });
    expect(out).toEqual([{ month: '2026-01', amount: 0 }, { month: '2026-02', amount: 0 }]);
  });

  it('negative amounts are kept as given', () => {
    const out = resolveMonthAmounts(['2026-01', '2026-02'], {
      months: [{ month: '2026-01', amount: -5 }, { month: '2026-02', amount: 7.5 }],
    });
    expect(out.map(m => m.amount)).toEqual([-5, 7.5]);
  });

  it('a numeric string is a number: "12.5" for a month and for the annual amount', () => {
    const keys = ['2026-01', '2026-02'];
    const split = resolveMonthAmounts(keys, {
      months: [{ month: '2026-01', amount: '12.5' as unknown as number }, { month: '2026-02', amount: 1 }],
    });
    expect(split.map(m => m.amount)).toEqual([12.5, 1]);
    expect(resolveMonthAmounts(keys, { annualAmount: '25' as unknown as number }).map(m => m.amount)).toEqual([12.5, 12.5]);
  });

  it('refuses an empty string and null as an amount (they are not 0)', () => {
    const keys = ['2026-01'];
    for (const bad of ['', null, 'abc', Infinity]) {
      expect(() => resolveMonthAmounts(keys, { months: [{ month: '2026-01', amount: bad as unknown as number }] }), String(bad))
        .toThrow(BudgetInputError);
    }
  });

  it('rounds to cents half away from zero on the decimal value, as the NUMERIC(15,2) column does', () => {
    const [a, b, c] = resolveMonthAmounts(['2026-01', '2026-02', '2026-03'], {
      months: [{ month: '2026-01', amount: 1.234 }, { month: '2026-02', amount: 1.005 }, { month: '2026-03', amount: -1.005 }],
    });
    expect([a!.amount, b!.amount, c!.amount]).toEqual([1.23, 1.01, -1.01]);
  });

  it('a split of 15 months is accepted', () => {
    const keys = [...KEYS_14, '2027-03'];
    const out = resolveMonthAmounts(keys, { annualAmount: 150 });
    expect(out).toHaveLength(15);
    expect(out.every(m => m.amount === 10)).toBe(true);
  });

  it('refuses neither months nor an annual amount', () => {
    expect(() => resolveMonthAmounts(['2026-01'], {})).toThrow(BudgetInputError);
  });
});

describe('round2', () => {
  it.each([
    [1.005, 1.01], [-1.005, -1.01], [2.675, 2.68], [1.235, 1.24], [0.5, 0.5], [1.004, 1],
    [8333.335, 8333.34], [0.1 + 0.2, 0.3], [1e-7, 0], [-1e-7, 0], [1e21, 1e21], [0, 0],
  ])('%s -> %s', (input, expected) => {
    expect(Object.is(round2(input), expected)).toBe(true);
  });

  it('passes a non-finite number through', () => {
    expect(round2(Number.NaN)).toBeNaN();
    expect(round2(Infinity)).toBe(Infinity);
  });
});
