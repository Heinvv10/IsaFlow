/**
 * The budget month helpers that remain: the decimal rounding the readers use and the strict
 * year-label parse (the even spread and the split check left with the legacy writers in
 * budgets P2 PR-D; the grid's spread is services/budgets/grid/spread).
 */
import { describe, it, expect } from 'vitest';
import { parseYearLabel, round2 } from '@/modules/accounting/services/core/budgetMonths';

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

describe('parseYearLabel', () => {
  it.each([[2027, 2027], ['2027', 2027], [1, 1], ['0001', 1], [9999, 9999], ['9999', 9999]])('%j is the label %i', (raw, label) => {
    expect(parseYearLabel(raw)).toBe(label);
  });

  it.each([
    true, false, null, undefined, '', ' ', '0', 0, -1, '-1', '1e3', 1e3 + 0.5, '2.5', 2.5, '20x6', '2027 ', ' 2027',
    '12345', 12345, [2027], ['2027'], {}, Number.NaN, Infinity, '٢٠٢٧',
  ])('%j is not a label', (raw) => {
    expect(parseYearLabel(raw)).toBeNull();
  });
});
