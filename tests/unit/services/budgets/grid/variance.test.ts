/**
 * `rowVariance` (spec §6.1 columns 5 and 7): Δ vs PY in rand and %, Δ vs a compare version, and
 * whether each is favourable. The grid's rows only print what this returns.
 * Polarity: revenue up is favourable, expense up is unfavourable; no movement is neither.
 * PY = 0 gives no percentage (the grid prints "—"), never a percentage of zero.
 *
 * Mutations: polarity ignored (expense up favourable); % over signed PY instead of |PY|; PY = 0
 * divided anyway.
 */
import { describe, it, expect } from 'vitest';
import { rowVariance } from '@/modules/accounting/services/budgets/grid/variance';

describe('rowVariance', () => {
  it.each([
    { name: 'revenue up', fy: 120_00, py: 100_00, cmp: null, income: true, want: { dPy: 20_00, pct: 20, favPy: true, dCmp: null, favCmp: undefined } },
    { name: 'revenue down', fy: 80_00, py: 100_00, cmp: null, income: true, want: { dPy: -20_00, pct: -20, favPy: false } },
    { name: 'expense up', fy: 120_00, py: 100_00, cmp: null, income: false, want: { dPy: 20_00, pct: 20, favPy: false } },
    { name: 'expense down', fy: 50_00, py: 100_00, cmp: null, income: false, want: { dPy: -50_00, pct: -50, favPy: true } },
    { name: 'no movement', fy: 100_00, py: 100_00, cmp: null, income: true, want: { dPy: 0, pct: 0, favPy: undefined } },
    { name: 'negative PY: % over |PY|', fy: -50_00, py: -100_00, cmp: null, income: true, want: { dPy: 50_00, pct: 50, favPy: true } },
    { name: 'PY zero: no %', fy: 10_00, py: 0, cmp: null, income: true, want: { dPy: 10_00, pct: null, pyZero: true } },
    { name: 'compare', fy: 100_00, py: null, cmp: 130_00, income: false, want: { dPy: null, pct: null, dCmp: -30_00, favCmp: true } },
  ])('$name', ({ fy, py, cmp, income, want }) => {
    expect(rowVariance(fy, py, cmp, income)).toMatchObject(want);
  });

  it('not budgeted: nothing to compare', () => {
    expect(rowVariance(null, 100_00, 50_00, true)).toEqual({ dPy: null, pct: null, pyZero: false, favPy: undefined, dCmp: null, favCmp: undefined });
  });
});
