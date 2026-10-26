/**
 * Budget grid money: rand → integer cents, half away from zero on the decimal
 * value, and rounding cents to a whole-rand unit (decision 5: R1/R100/R1000).
 */
import { describe, it, expect } from 'vitest';
import { fromCents, roundToUnit, toCents } from '@/modules/accounting/services/budgets/grid/cents';

describe('toCents', () => {
  it.each([
    [0, 0],
    [1, 100],
    [1234.5, 123450],
    [1.005, 101],
    [-1.005, -101],
    [0.125, 13],
    [-0.125, -13],
    [2.675, 268],
    [1e-7, 0],
    [9999999999999.99, 999999999999999],
  ])('%s → %s', (rand, cents) => {
    expect(toCents(rand)).toBe(cents);
  });

  it('never returns negative zero', () => {
    expect(Object.is(toCents(-0.001), 0)).toBe(true);
  });

  it('refuses a non-finite number', () => {
    expect(() => toCents(Number.NaN)).toThrow(RangeError);
    expect(() => toCents(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('fromCents', () => {
  it('is the inverse of toCents', () => {
    expect(fromCents(123450)).toBe(1234.5);
    expect(fromCents(-101)).toBe(-1.01);
    expect(Object.is(fromCents(-0), 0)).toBe(true);
  });
});

describe('roundToUnit', () => {
  it.each([
    // [cents, unit, expected cents]
    [123456, 1, 123500],
    [123449, 1, 123400],
    [150, 1, 200],
    [250, 1, 300],
    [-250, 1, -300],
    [-150, 1, -200],
    [5000, 100, 10000],
    [15000, 100, 20000],
    [-15000, 100, -20000],
    [14999, 100, 10000],
    [50000, 1000, 100000],
    [250000, 1000, 300000],
    [-250000, 1000, -300000],
    [249999, 1000, 200000],
    [0, 1000, 0],
  ])('%s cents at R%s → %s', (cents, unit, expected) => {
    expect(roundToUnit(cents, unit as 1 | 100 | 1000)).toBe(expected);
  });

  it('never returns negative zero', () => {
    expect(Object.is(roundToUnit(-40, 1), 0)).toBe(true);
  });

  it('refuses fractional cents and an unknown unit', () => {
    expect(() => roundToUnit(10.5, 1)).toThrow(RangeError);
    expect(() => roundToUnit(100, 10 as 1)).toThrow(RangeError);
  });
});
