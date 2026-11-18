import { describe, expect, it } from 'vitest';
import {
  cents, expectedTotalsRefusal, lineCents, poCents,
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
    // gross = 3 x 19.99 x 1.15 = 68.9655 -> 68.97; VAT = 68.97 x 15/115 = 8.996 -> 9.00; net 59.97
    expect(lineCents({ quantity: 3, unitPrice: 19.99, taxRate: 15 }, true)).toEqual({ net: 5997, tax: 900 });
    // A case where the two roundings differ by a cent: 7 x 1.43 = 10.01 net.
    const exclusive = lineCents({ quantity: 7, unitPrice: 1.43, taxRate: 15 }, false) as { net: number; tax: number };
    const inclusive = lineCents({ quantity: 7, unitPrice: 1.43, taxRate: 15 }, true) as { net: number; tax: number };
    expect(exclusive).toEqual({ net: 1001, tax: 150 });
    expect(inclusive.net + inclusive.tax).toBe(1151); // gross 11.5115 -> 11.51
    expect(inclusive).toEqual({ net: 1001, tax: 150 });
  });

  it('the source\'s own line_total and tax_amount are stored as sent (a discount, more price decimals)', () => {
    // 10 x 86.9565 = 869.565, but the source says 826.09 after a 5% discount.
    expect(lineCents({ quantity: 10, unitPrice: 86.9565, taxRate: 15, lineTotal: 826.09, taxAmount: 123.91 }, false))
      .toEqual({ net: 82609, tax: 12391 });
  });

  it('line_total alone computes the VAT from it', () => {
    expect(lineCents({ quantity: 1, unitPrice: 1, taxRate: 15, lineTotal: 200 }, false)).toEqual({ net: 20000, tax: 3000 });
  });

  it('a VAT that disagrees with the line amount by more than 2 cents is refused; rounding is not', () => {
    expect(lineCents({ quantity: 1, unitPrice: 100, taxRate: 15, lineTotal: 100, taxAmount: 15.02 }, false)).toEqual({ net: 10000, tax: 1502 });
    expect(lineCents({ quantity: 1, unitPrice: 100, taxRate: 15, lineTotal: 100, taxAmount: 15.03 }, false))
      .toBe('tax_amount 15.03 does not match line_total 100.00 at 15% (expected about 15.00)');
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
