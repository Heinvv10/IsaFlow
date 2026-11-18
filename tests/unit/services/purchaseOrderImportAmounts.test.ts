import { describe, expect, it } from 'vitest';
import {
  cents, expectedTotalsRefusal, lineCents, poCents, storedUnitPrice,
} from '@/modules/accounting/services/ap/purchaseOrderImportAmounts';

describe('cents', () => {
  it('rounds half up through binary noise', () => {
    expect(cents(1.005)).toBe(101);
    expect(cents(282543.34)).toBe(28254334);
    expect(cents(0.1 + 0.2)).toBe(30);
  });
});

describe('lineCents', () => {
  it('exclusive: net = qty x price, VAT on the rounded net', () => {
    expect(lineCents({ quantity: 3, unitPrice: 19.99, taxRate: 15 }, false)).toEqual({ net: 5997, tax: 900 });
  });

  it('inclusive: VAT is taken out of the rounded gross, as an inclusive document computes it', () => {
    // 1 x 1.0143: exclusive net 1.01 (VAT 0.15); inclusive gross round(1.166445) = 1.17, VAT 0.15, net 1.02.
    expect(lineCents({ quantity: 1, unitPrice: 1.0143, taxRate: 15 }, false)).toEqual({ net: 101, tax: 15 });
    expect(lineCents({ quantity: 1, unitPrice: 1.0143, taxRate: 15 }, true)).toEqual({ net: 102, tax: 15 });
    // Where the roundings agree, so do the modes.
    expect(lineCents({ quantity: 3, unitPrice: 19.99, taxRate: 15 }, true)).toEqual({ net: 5997, tax: 900 });
  });

  it('refuses a line_total above quantity x unit_price: the VAT-inclusive total sent as the ex-VAT amount', () => {
    expect(lineCents({ quantity: 10, unitPrice: 100, taxRate: 15, lineTotal: 1150 }, false))
      .toBe('line_total 1150.00 is more than quantity x unit_price (1000.00): send the ex-VAT line amount (Sage Exclusive), not the VAT-inclusive total');
    expect(lineCents({ quantity: 10, unitPrice: 100, taxRate: 15, lineTotal: 1000.01 }, false)).toEqual({ net: 100001, tax: 15000 });
  });

  it('the source\'s own line_total and tax_amount are stored as sent (a discount, more price decimals)', () => {
    // 10 x 86.9565 = 869.565, but the source says 826.09 after a 5% discount.
    expect(lineCents({ quantity: 10, unitPrice: 86.9565, taxRate: 15, lineTotal: 826.09, taxAmount: 123.91 }, false))
      .toEqual({ net: 82609, tax: 12391 });
  });

  it('line_total alone computes the VAT from it', () => {
    expect(lineCents({ quantity: 1, unitPrice: 200, taxRate: 15, lineTotal: 200 }, false)).toEqual({ net: 20000, tax: 3000 });
  });

  it('a VAT that disagrees with the line amount by more than 2 cents is refused; rounding is not', () => {
    expect(lineCents({ quantity: 1, unitPrice: 100, taxRate: 15, lineTotal: 100, taxAmount: 15.02 }, false)).toEqual({ net: 10000, tax: 1502 });
    expect(lineCents({ quantity: 1, unitPrice: 100, taxRate: 15, lineTotal: 100, taxAmount: 15.03 }, false))
      .toBe('tax_amount 15.03 does not match line_total 100.00 at 15% (expected about 15.00; tax_rate defaults to 15 — send the line\'s own rate)');
    expect(lineCents({ quantity: 1, unitPrice: 100, taxRate: 0, lineTotal: 100, taxAmount: 15 }, false)).toMatch(/does not match/);
  });

  it('tax_amount without line_total is refused', () => {
    expect(lineCents({ quantity: 1, unitPrice: 1, taxRate: 15, taxAmount: 0.15 }, false)).toBe('tax_amount needs line_total (send both, or neither)');
  });
});

describe('poCents and expected totals', () => {
  const lines = [{ net: 10000, tax: 1500 }, { net: 333, tax: 50 }];

  it('sums the lines', () => {
    expect(poCents(lines)).toEqual({ subtotal: 10333, tax: 1550, total: 11883 });
  });

  it('accepts expected totals equal to the cent, any subset sent', () => {
    const got = poCents(lines);
    expect(expectedTotalsRefusal(got, undefined)).toBeNull();
    expect(expectedTotalsRefusal(got, { total: 118.83 })).toBeNull();
    expect(expectedTotalsRefusal(got, { subtotal: 103.33, taxAmount: 15.5, total: 118.83 })).toBeNull();
  });

  it('refuses a one-cent difference, naming the field and both figures', () => {
    const got = poCents(lines);
    expect(expectedTotalsRefusal(got, { total: 118.84 })).toBe('expected_totals.total is 118.84 but the lines add up to 118.83');
    expect(expectedTotalsRefusal(got, { taxAmount: 15.49 })).toBe('expected_totals.tax_amount is 15.49 but the lines add up to 15.50');
  });
});

describe('storedUnitPrice', () => {
  it('is the effective ex-VAT price, so round(quantity x price) gives the line amount back', () => {
    expect(storedUnitPrice(3, 10000)).toBe(33.333333); // 3 x 33.333333 = 99.999999 -> 100.00
    expect(storedUnitPrice(10, 90000)).toBe(90); // a 10% discount on 10 x 100
    expect(storedUnitPrice(1000, 123450)).toBe(1.2345);
  });

  it('is null when no 6-decimal price rounds back to the amount', () => {
    expect(storedUnitPrice(3_000_000, 100)).toBeNull();
  });
});
