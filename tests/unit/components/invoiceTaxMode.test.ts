/**
 * taxMode.ts — what the invoice form's excl / incl / none choice does to a typed price. Since the per-line VAT writer PR
 * the invoice form sends the price AS TYPED with its mode and the server backs an inclusive line's VAT out of its gross,
 * so an inclusive total is exactly what was typed (the drift spec decision 2 quoted, 3 x R10 incl storing R30.02, is
 * gone). The totals here are formTotals, the page's own, which is the pricing the server stores. The quote form still
 * converts (storedUnitPrice / lineTotalForMode).
 */
import { describe, expect, it } from 'vitest';
import {
  effectiveTaxRate, exVatUnitPrice, grossUnitPrice, inclusiveTypedTotal, lineTotalForMode, linesForModeChange, pricesToNothing, storedUnitPrice, type TaxMode,
} from '@/components/accounting/customer-invoices/taxMode';
import { formTotals, lineVatWarning } from '@/components/accounting/customer-invoices/formVat';

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
const invoice = (mode: TaxMode, lines: ReturnType<typeof line>[]) =>
  formTotals(lines, lines.map(() => 'standard' as const), mode, '2026-11-20');

describe('the stored invoice for what was typed', () => {
  it('3 x R10 incl comes to the R30.00 typed (it stored R30.02 when the form converted the price)', () => {
    const lines = [line(3, 10)];
    expect(invoice('inclusive', lines)).toEqual({ subtotal: 26.09, tax: 3.91, total: 30 });
    expect(inclusiveTypedTotal(lines)).toBe(30);
  });

  it('1 x R10 incl comes to R10.00: the VAT is backed out of the line\'s gross (it stored R10.01)', () => {
    const lines = [line(1, 10)];
    expect(invoice('inclusive', lines)).toEqual({ subtotal: 8.7, tax: 1.3, total: 10 });
    expect(inclusiveTypedTotal(lines)).toBe(10);
  });

  it('1 000 x R10 incl comes to the R10 000.00 typed (it stored R10 005.00)', () => {
    const lines = [line(1000, 10)];
    expect(invoice('inclusive', lines).total).toBe(10000);
    expect(inclusiveTypedTotal(lines)).toBe(10000);
  });

  it('the quote form still converts an inclusive price to ex-VAT (quoteVat)', () => {
    expect(storedUnitPrice('inclusive', 10, 15)).toBe(8.7);
    expect(lineTotalForMode('inclusive', 15, line(3, 10))).toBe(26.1);
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
    // The price is sent as typed in every mode, so only its own column rounding matters.
    expect(pricesToNothing(0.004)).toBe(true); // the column stores 0.00
    expect(pricesToNothing(0.01)).toBe(false); // an inclusive R0.01 at 150% was 0.004 once converted; it is sent as 0.01 now
    expect(pricesToNothing(0)).toBe(false); // nothing was typed
    expect(pricesToNothing(0.005)).toBe(false); // rounds to a cent
    expect(pricesToNothing(Number.POSITIVE_INFINITY)).toBe(false); // mid-edit, not a crash
  });
});

describe('lineVatWarning (the customer\'s VAT type against the lines\' types; the user\'s choice stands)', () => {
  it.each([
    ['zero', ['standard'], 'This customer is zero-rated, but a line is standard-rated.'],
    ['exempt', ['standard', 'exempt', 'standard'], 'This customer is VAT exempt, but 2 lines are standard-rated.'],
    [' ZERO ', ['standard'], 'This customer is zero-rated, but a line is standard-rated.'],
    ['standard', ['zero_rated', 'exempt'], 'This customer is standard-rated, but no line charges VAT.'],
    ['Reduced', ['standard'], 'This customer\'s VAT type "reduced" is not one IsaFlow knows: check the VAT type on each line.'],
    ['Reduced', ['zero_rated'], 'This customer\'s VAT type "reduced" is not one IsaFlow knows: check the VAT type on each line.'],
  ] as const)('%s with %j warns', (vatType, types, message) => {
    expect(lineVatWarning(vatType, types)).toBe(message);
  });

  it.each([
    ['zero', ['zero_rated']], ['exempt', ['exempt', 'zero_rated']], ['standard', ['standard', 'exempt']], [null, ['standard']],
    [null, ['zero_rated']], ['', ['standard']], ['   ', ['exempt']], [undefined, ['standard']], ['standard', []],
  ] as const)('%s with %j says nothing', (vatType, types) => {
    expect(lineVatWarning(vatType, types)).toBeUndefined();
  });
});
