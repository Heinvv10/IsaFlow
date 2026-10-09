/**
 * invoiceLineAmount.ts — the one pricing of a customer-invoice line and its
 * totals, shared by create, the draft edit and the page previews. Exact
 * decimal, half away from zero (numeric ROUND), on the quantity and price as
 * their numeric(…, 2) columns store them.
 */
import { describe, it, expect } from 'vitest';
import {
  discountFromAmount, invoiceLineAmount, invoiceTotals, isDiscountPercent, previewLineAmount, previewTotals, toColumnCents,
} from '@/modules/accounting/services/ar/invoiceLineAmount';
import { NotADecimalError } from '@/modules/accounting/services/shared/functionalAmounts';

describe('invoiceLineAmount', () => {
  it.each([
    [1, 1000, 10, 900],
    [3, 33.33, 12.5, 87.49],      // 87.49125
    [1, 1.005, 0, 1.01],          // the price is stored as 1.01; float Math.round gives 1.00
    [1, 4.35, 0, 4.35],           // float 4.35 * 100 = 434.99999…
    [3, 0.1, 0, 0.3],
    [1, 1, 0.5, 1.00],            // 0.995 -> 1.00, half away from zero
    [1, 0.01, 50, 0.01],          // 0.005 -> 0.01
    [1, 400, 100, 0],
    [2.5, 19.99, 33.33, 33.32],   // 49.975 × 0.6667 = 33.3183…
    [1, 0.125, 0, 0.13],          // the price as its column stores it
    [1.005, 100, 0, 101],         // so is the quantity: 1.01 × 100
  ])('qty %s × %s less %s%% = %s', (qty, price, discount, expected) => {
    expect(invoiceLineAmount(qty, price, discount)).toBe(expected);
  });

  it('a stored line re-prices to its own amount: price and quantity are taken at two places', () => {
    // 3 × 33.333 = 99.999 would round to 100.00, but the row stores 33.33 × 3 = 99.99.
    expect(invoiceLineAmount(3, 33.333, 0)).toBe(99.99);
    expect(toColumnCents(33.333)).toBe(33.33);
  });

  it('defaults to no discount', () => {
    expect(invoiceLineAmount(2, 250)).toBe(500);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('throws on a non-finite input (%s)', (bad) => {
    expect(() => invoiceLineAmount(1, bad, 0)).toThrow(NotADecimalError);
  });
});

describe('invoiceTotals', () => {
  it('subtotal is the sum of the line amounts; VAT and total on it', () => {
    expect(invoiceTotals([87.49, 0.13, 0.13, 0.13], 15)).toEqual({ subtotal: 87.88, tax: 13.18, total: 101.06 });
  });

  it('rounds VAT half away from zero, exactly: 15% of 0.10 is 0.02 (float gives 0.01)', () => {
    expect(invoiceTotals([0.1], 15)).toEqual({ subtotal: 0.1, tax: 0.02, total: 0.12 });
  });

  it('handles a fractional rate and a zero rate', () => {
    expect(invoiceTotals([1000], 7.5)).toEqual({ subtotal: 1000, tax: 75, total: 1075 });
    expect(invoiceTotals([1000, 0.01], 0)).toEqual({ subtotal: 1000.01, tax: 0, total: 1000.01 });
  });

  it('an invoice with no lines totals zero', () => {
    expect(invoiceTotals([], 15)).toEqual({ subtotal: 0, tax: 0, total: 0 });
  });
});

describe('the previews', () => {
  it('price as the server does', () => {
    expect(previewLineAmount(3, 33.33, 12.5)).toBe(invoiceLineAmount(3, 33.33, 12.5));
    expect(previewTotals([0.1], 15)).toEqual(invoiceTotals([0.1], 15));
  });

  it('show 0 for a field mid-edit rather than throwing', () => {
    expect(previewLineAmount(Number.NaN, 10, 0)).toBe(0);
    expect(previewLineAmount(1, 10, Number.NaN)).toBe(0);
    expect(previewTotals([10], Number.NaN)).toEqual({ subtotal: 0, tax: 0, total: 0 });
  });
});

describe('discountFromAmount — the edit form reads a stored line back', () => {
  it.each([
    [1, 1000, 10],
    [1, 1000, 12.34],    // to 0.1% this read back as 12.3 and an unchanged save billed 877.00, not 876.60
    [3, 33.33, 12.5],
    [7, 13.37, 33.33],
    [1000, 9999.99, 87.26],   // a R10m base: a 7-place discount here re-priced a cent off (breaker round 2)
    [1, 0.01, 50],
    [2.5, 19.99, 0.01],
    [1, 400, 100],
  ])('qty %s × %s less %s%%: an unchanged save re-prices to the stored amount', (qty, price, typed) => {
    const stored = invoiceLineAmount(qty, price, typed);
    const readBack = discountFromAmount(qty, price, stored);
    expect(invoiceLineAmount(qty, price, readBack)).toBe(stored);
  });

  it('prefers the short figure the operator typed', () => {
    expect(discountFromAmount(1, 1000, 900)).toBe(10);
    expect(discountFromAmount(1, 1000, 876.6)).toBe(12.34);
  });

  it('reads back every two-place discount exactly, on any base the columns hold (seeded search)', () => {
    let seed = 20261009;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const misses: string[] = [];
    for (let i = 0; i < 20000; i++) {
      const qty = Math.max(1, Math.round(10 ** (rnd() * 6))) / 100;          // 0.01 … 10 000
      const price = Math.round(10 ** (rnd() * 11)) / 100;                    // 0.01 … 1 000 000 000
      const d = Math.round(rnd() * 10000) / 100;                             // 0.00 … 100.00
      const stored = invoiceLineAmount(qty, price, d);
      const readBack = discountFromAmount(qty, price, stored);
      if (!isDiscountPercent(readBack) || invoiceLineAmount(qty, price, readBack) !== stored) misses.push(`${qty}×${price}@${d}`);
    }
    expect(misses).toEqual([]);
  });

  it('is 0 for an undiscounted line, a zero base, or an amount above qty × price', () => {
    expect(discountFromAmount(2, 250, 500)).toBe(0);
    expect(discountFromAmount(1, 0, 0)).toBe(0);
    expect(discountFromAmount(3, 33.33, 100)).toBe(0);
    expect(discountFromAmount(1, Number.NaN, 1)).toBe(0);
  });
});

describe('isDiscountPercent', () => {
  it.each([0, 10, 12.5, 12.34, 99.99, 100, 0.01])('accepts %s', (d) => expect(isDiscountPercent(d)).toBe(true));
  it.each([-0.01, 100.01, 12.345, 87.2574374, 1e-7, Number.NaN, Number.POSITIVE_INFINITY, '10', true, null, [10]])(
    'refuses %s', (d) => expect(isDiscountPercent(d)).toBe(false));
});
