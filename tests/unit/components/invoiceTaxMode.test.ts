/**
 * taxMode.ts — what the invoice form's excl / incl / none choice does to a typed price. The invoice stores only
 * tax_rate and 2-dp ex-VAT unit prices, so "inclusive" converts in the form and can land off the typed gross. The
 * drift figures here are the ones spec decision 2 quotes; they are computed through the same pricing the server stores.
 */
import { describe, expect, it } from 'vitest';
import {
  effectiveTaxRate, exVatUnitPrice, inclusiveTypedTotal, lineTotalForMode, storedUnitPrice, taxModeFromVatType, type TaxMode,
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

describe('taxModeFromVatType', () => {
  it.each([
    ['zero', 'none'],
    ['exempt', 'none'],
    ['standard', 'exclusive'],
    ['', null],
    [null, null],
    ['something a script wrote', null],
  ])('%s -> %s', (vatType, mode) => {
    expect(taxModeFromVatType(vatType)).toBe(mode);
  });
});
