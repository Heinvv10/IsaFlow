/**
 * taxMode.ts — what the invoice form's excl / incl / none choice does to a typed price. The invoice stores only
 * tax_rate and 2-dp ex-VAT unit prices, so "inclusive" converts in the form and can land off the typed gross. The
 * drift figures here are the ones spec decision 2 quotes; they are computed through the same pricing the server stores.
 */
import { describe, expect, it } from 'vitest';
import {
  effectiveTaxRate, exVatUnitPrice, grossUnitPrice, inclusiveTypedTotal, lineTotalForMode, linesForModeChange, pricesToNothing, storedUnitPrice, taxModeFromVatType, vatTypeWarning, type TaxMode,
} from '@/components/accounting/customer-invoices/taxMode';
import { previewTotals } from '@/modules/accounting/services/ar/invoiceLineAmount';

describe('exVatUnitPrice', () => {
  it.each([
    [115, 15, 100],
    [10, 15, 8.7], // 8.6956… rounds up: truncating gives 8.69
    [10, 0, 10],
    [115, 0, 115],
    [1.15, 15, 1],
    [100, 14, 87.72],
    [-115, 15, -100],
  ])('%s at %s percent = %s', (gross, rate, ex) => {
    expect(exVatUnitPrice(gross, rate)).toBe(ex);
  });

  it('rounds half away from zero, on exact decimals', () => {
    expect(exVatUnitPrice(1.15, 130)).toBe(0.5); // exactly 0.5
    expect(exVatUnitPrice(0.05, 100)).toBe(0.03); // exactly 0.025: a float calculation can land either side
    expect(exVatUnitPrice(-0.05, 100)).toBe(-0.03);
  });

  it.each([[Number.NaN, 15], [115, Number.NaN], [Number.POSITIVE_INFINITY, 15], [115, -100]])('a half-typed %s at %s percent prices as 0, not a crash', (gross, rate) => {
    expect(exVatUnitPrice(gross, rate)).toBe(0);
  });
});

describe('grossUnitPrice', () => {
  it.each([
    [1000, 15, 1150],
    [500, 15, 575],
    [8.7, 15, 10.01], // 10.005 exactly, half away from zero: a float calculation lands on 10
    [100, 14, 114],
    [115, 0, 115],
    [-100, 15, -115],
    [0.125, 15, 0.15], // grossed from what the column stores, 0.13: from 0.125 it is 0.14, which comes back as 0.12
  ])('%s at %s percent = %s', (ex, rate, gross) => {
    expect(grossUnitPrice(ex, rate)).toBe(gross);
  });

  it.each([[Number.NaN, 15], [115, Number.NaN], [Number.POSITIVE_INFINITY, 15]])('a half-typed %s at %s percent is left as it is', (ex, rate) => {
    expect(grossUnitPrice(ex, rate)).toBe(ex);
  });

  it.each([0, 5, 14, 15, 15.5, 27, 100, 150])('every stored price comes back exact at %s percent', (rate) => {
    for (let cents = 1; cents <= 30_000; cents++) {
      const ex = cents / 100;
      if (exVatUnitPrice(grossUnitPrice(ex, rate), rate) !== ex) throw new Error(`${ex} at ${rate}% does not come back`);
    }
  });
});

describe('linesForModeChange', () => {
  const lines = [{ unitPrice: 1000, discount: 10 }, { unitPrice: 500, discount: 0 }];
  const prices = (from: TaxMode, to: TaxMode) => linesForModeChange(lines, from, to, 15).map((l) => l.unitPrice);

  it('grosses up on the way into inclusive, from either other mode', () => {
    expect(prices('exclusive', 'inclusive')).toEqual([1150, 575]);
    expect(prices('none', 'inclusive')).toEqual([1150, 575]);
  });

  it('takes the VAT back out on the way out of inclusive, to either other mode', () => {
    const shown = [{ unitPrice: 1150 }, { unitPrice: 575 }];
    expect(linesForModeChange(shown, 'inclusive', 'exclusive', 15).map((l) => l.unitPrice)).toEqual([1000, 500]);
    expect(linesForModeChange(shown, 'inclusive', 'none', 15).map((l) => l.unitPrice)).toEqual([1000, 500]);
  });

  it('converts nothing at a rate below 0, where the way back is not exact', () => {
    expect(linesForModeChange(lines, 'exclusive', 'inclusive', -5).map((l) => l.unitPrice)).toEqual([1000, 500]);
    expect(linesForModeChange(lines, 'inclusive', 'exclusive', -5).map((l) => l.unitPrice)).toEqual([1000, 500]);
  });

  it('leaves a price mid-edit as it is, either way, and still converts the rest', () => {
    const half = [{ unitPrice: Number.NaN }, { unitPrice: 115 }];
    expect(linesForModeChange(half, 'inclusive', 'exclusive', 15).map((l) => l.unitPrice)).toEqual([Number.NaN, 100]);
    expect(linesForModeChange(half, 'exclusive', 'inclusive', 15).map((l) => l.unitPrice)).toEqual([Number.NaN, 132.25]);
  });

  it('converts nothing at a rate that cannot be read', () => {
    expect(linesForModeChange(lines, 'exclusive', 'inclusive', Number.NaN).map((l) => l.unitPrice)).toEqual([1000, 500]);
    expect(linesForModeChange(lines, 'inclusive', 'exclusive', Number.NaN).map((l) => l.unitPrice)).toEqual([1000, 500]);
  });

  it('leaves the price alone between exclusive and No VAT, and keeps the rest of the line', () => {
    expect(prices('exclusive', 'none')).toEqual([1000, 500]);
    expect(prices('none', 'exclusive')).toEqual([1000, 500]);
    expect(linesForModeChange(lines, 'exclusive', 'inclusive', 15)[0]!.discount).toBe(10);
  });
});

const line = (quantity: number, unitPrice: number, discount = 0) => ({ quantity, unitPrice, discount });
const invoice = (mode: TaxMode, lines: ReturnType<typeof line>[], formRate = 15) => {
  const rate = effectiveTaxRate(mode, formRate);
  return previewTotals(lines.map((l) => lineTotalForMode(mode, rate, l)), rate);
};

describe('the stored invoice for what was typed', () => {
  it('3 x R10 incl comes to R30.02 against the R30.00 typed', () => {
    const lines = [line(3, 10)];
    expect(invoice('inclusive', lines).total).toBe(30.02);
    expect(inclusiveTypedTotal(lines)).toBe(30);
  });

  it('1 x R10 incl comes to R10.01: VAT is rounded after the price is, so even one unit can land a cent off', () => {
    const lines = [line(1, 10)];
    expect(invoice('inclusive', lines)).toEqual({ subtotal: 8.7, tax: 1.31, total: 10.01 });
    expect(inclusiveTypedTotal(lines)).toBe(10);
  });

  it('1 000 x R10 incl comes to R10 005.00 against the R10 000.00 typed', () => {
    const lines = [line(1000, 10)];
    expect(invoice('inclusive', lines).total).toBe(10005);
    expect(inclusiveTypedTotal(lines)).toBe(10000);
  });

  it('1 x R115 incl is exact', () => {
    const lines = [line(1, 115)];
    expect(invoice('inclusive', lines)).toEqual({ subtotal: 100, tax: 15, total: 115 });
    expect(inclusiveTypedTotal(lines)).toBe(115);
  });

  it('a typed total carries the line discount', () => {
    const lines = [line(2, 115, 10)];
    expect(invoice('inclusive', lines)).toEqual({ subtotal: 180, tax: 27, total: 207 });
    expect(inclusiveTypedTotal(lines)).toBe(207);
  });

  it('adds up in cents, not floats', () => {
    expect(inclusiveTypedTotal([line(1, 0.1), line(1, 0.2)])).toBe(0.3);
  });

  it('exclusive sends the typed price untouched, whatever its precision', () => {
    expect(storedUnitPrice('exclusive', 10.005, 15)).toBe(10.005);
    expect(invoice('exclusive', [line(3, 10)])).toEqual({ subtotal: 30, tax: 4.5, total: 34.5 });
  });

  it('none is rate 0 whatever the form holds, and the price is untouched', () => {
    expect(effectiveTaxRate('none', 15)).toBe(0);
    expect(effectiveTaxRate('exclusive', 15)).toBe(15);
    expect(effectiveTaxRate('inclusive', 14)).toBe(14);
    expect(storedUnitPrice('none', 115, 0)).toBe(115);
    expect(invoice('none', [line(1, 115)])).toEqual({ subtotal: 115, tax: 0, total: 115 });
  });
});

describe('pricesToNothing', () => {
  it('is a price typed above zero that stores as zero', () => {
    expect(pricesToNothing('inclusive', 0.004, 15)).toBe(true);
    expect(pricesToNothing('inclusive', 0.01, 150)).toBe(true); // 0.004: under half a cent
    expect(pricesToNothing('inclusive', 0.01, 15)).toBe(false); // 0.0087 rounds to a cent
    expect(pricesToNothing('inclusive', 0, 15)).toBe(false); // nothing was typed
    expect(pricesToNothing('exclusive', 0.004, 15)).toBe(true); // the column stores 0.00
    expect(pricesToNothing('none', 0.004, 0)).toBe(true);
    expect(pricesToNothing('exclusive', 0.005, 15)).toBe(false); // rounds to a cent
    expect(pricesToNothing('exclusive', Number.POSITIVE_INFINITY, 15)).toBe(false); // mid-edit, not a crash
  });
});

describe('taxModeFromVatType', () => {
  it.each([
    ['zero', 'none'],
    ['exempt', 'none'],
    ['standard', 'exclusive'],
    ['', null],
    [null, null],
    ['something a script wrote', null],
    [' Zero ', 'none'],
    ['EXEMPT', 'none'],
    ['  Standard', 'exclusive'],
  ])('%s -> %s', (vatType, mode) => {
    expect(taxModeFromVatType(vatType)).toBe(mode);
  });
});

describe('vatTypeWarning', () => {
  it.each([
    ['zero', 15, 'This customer is zero-rated, but this invoice charges VAT at 15%.'],
    ['exempt', 14, 'This customer is VAT exempt, but this invoice charges VAT at 14%.'],
    [' ZERO ', 15, 'This customer is zero-rated, but this invoice charges VAT at 15%.'],
    ['standard', 0, 'This customer is standard-rated, but this invoice charges no VAT.'],
    ['Reduced', 15, 'This customer\'s VAT type "reduced" is not one IsaFlow knows: check the VAT on this invoice.'],
    ['Reduced', 0, 'This customer\'s VAT type "reduced" is not one IsaFlow knows: check the VAT on this invoice.'],
  ])('%s at %s percent warns', (vatType, rate, message) => {
    expect(vatTypeWarning(vatType, rate)).toBe(message);
  });

  it.each([['zero', 0], ['exempt', 0], ['standard', 15], [null, 15], [null, 0], ['', 15], ['   ', 0], [undefined, 15]])('%s at %s percent says nothing', (vatType, rate) => {
    expect(vatTypeWarning(vatType, rate)).toBeUndefined();
  });
});
