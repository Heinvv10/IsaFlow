/**
 * The one per-line VAT pricing of a customer invoice (invoiceLineVatPricing), shared by create, the draft edit, the
 * unsaved preview and the pages' totals: exclusive and inclusive, with a discount, the header rule (subtotal / VAT /
 * total over the lines, header rate = the highest line rate), the untyped (non-vendor) shape, and the round trip: a
 * stored line re-prices to itself. Pure.
 */
import { describe, expect, it } from 'vitest';
import { priceInvoiceVat, previewInvoiceVat } from '@/modules/accounting/services/ar/invoiceLineVatPricing';
import { typedLinesProblem } from '@/modules/accounting/services/ar/invoiceVatLegs';

const DATE = '2026-11-20';
const l = (qty: number, price: number, discount = 0) => ({ quantity: qty, unitPrice: price, discount });

describe('exclusive', () => {
  it('1000 standard + 300 zero_rated + 200 exempt: 1500 / 150 / 1650, rate 15', () => {
    const p = priceInvoiceVat([l(1, 1000), l(1, 300), l(1, 200)], { typed: true, types: ['standard', 'zero_rated', 'exempt'] }, DATE, 'exclusive');
    expect(p.lines.map((x) => [x.amount, x.taxAmount, x.vatType, x.taxRate])).toEqual([
      [1000, 150, 'standard', 15], [300, 0, 'zero_rated', 0], [200, 0, 'exempt', 0],
    ]);
    expect(p.header).toEqual({ subtotal: 1500, tax: 150, total: 1650, taxRate: 15, amountsAre: 'exclusive' });
  });

  it('VAT is rounded per line: seven lines of 14.29 carry 14.98, where 15.00 was VAT on the subtotal', () => {
    const p = priceInvoiceVat(Array.from({ length: 7 }, () => l(1, 14.29)), { typed: true, types: Array(7).fill('standard') }, DATE, 'exclusive');
    expect(p.lines.every((x) => x.taxAmount === 2.14)).toBe(true);
    expect(p.header).toMatchObject({ subtotal: 100.03, tax: 14.98, total: 115.01 });
  });

  it('a discount is priced first (qty x price less discount), then VAT on the net', () => {
    const p = priceInvoiceVat([l(3, 33.33, 12.5)], { typed: true, types: ['standard'] }, DATE, 'exclusive');
    expect(p.lines[0]).toMatchObject({ qty: 3, price: 33.33, amount: 87.49, taxAmount: 13.12 });
  });

  it('an all-exempt invoice has header rate 0, not 15', () => {
    expect(priceInvoiceVat([l(1, 100)], { typed: true, types: ['exempt'] }, DATE, 'exclusive').header.taxRate).toBe(0);
  });

  it('a 2018-03-31 standard line is at 14%', () => {
    const p = priceInvoiceVat([l(1, 100)], { typed: true, types: ['standard'] }, '2018-03-31', 'exclusive');
    expect(p.lines[0]).toMatchObject({ taxAmount: 14, taxRate: 14 });
    expect(p.header.taxRate).toBe(14);
  });
});

describe('inclusive: unit_price as entered, amount the NET', () => {
  it('100 x 9.99 standard: gross 999.00, VAT 130.30, net 868.70; the price stored is 9.99', () => {
    const p = priceInvoiceVat([l(100, 9.99)], { typed: true, types: ['standard'] }, DATE, 'inclusive');
    expect(p.lines[0]).toMatchObject({ qty: 100, price: 9.99, amount: 868.7, taxAmount: 130.3, taxRate: 15 });
    expect(p.header).toEqual({ subtotal: 868.7, tax: 130.3, total: 999, taxRate: 15, amountsAre: 'inclusive' });
  });

  it('the total is exactly what was entered, line by line (the client conversion drifted: 3 @ R10 stored R30.02)', () => {
    const p = priceInvoiceVat([l(3, 10), l(7, 33.33, 5), l(2, 0.07)], { typed: true, types: ['standard', 'standard', 'exempt'] }, DATE, 'inclusive');
    expect(p.header.total).toBe(251.78);
  });

  it('an unrated line on an inclusive invoice: gross = net', () => {
    const p = priceInvoiceVat([l(1, 200)], { typed: true, types: ['zero_rated'] }, DATE, 'inclusive');
    expect(p.lines[0]).toMatchObject({ amount: 200, taxAmount: 0 });
  });
});

describe('what is stored passes the poster\'s own check (typedLinesProblem)', () => {
  it.each(['exclusive', 'inclusive'] as const)('%s, mixed, discounted, many lines', (mode) => {
    const lines = [l(3, 33.33, 12.5), l(7, 14.29), l(1, 0.07), l(100, 9.99), l(2.5, 19.99, 33.33), l(1, 300), l(1, 200)];
    const types = ['standard', 'standard', 'standard', 'standard', 'standard', 'zero_rated', 'exempt'] as const;
    const p = priceInvoiceVat(lines, { typed: true, types: [...types] }, DATE, mode);
    expect(typedLinesProblem(p.lines.map((x) => ({ amount: x.amount, taxAmount: x.taxAmount, vatType: x.vatType, glAccountId: null, projectId: null })),
      { subtotal: p.header.subtotal, taxAmount: p.header.tax, totalAmount: p.header.total, invoiceDate: DATE, amountsAre: mode })).toBeNull();
  });
});

describe('a stored line re-prices to itself', () => {
  it.each(['exclusive', 'inclusive'] as const)('%s: re-pricing the stored qty / price / discount gives the stored rows', (mode) => {
    const lines = [l(3, 33.33, 12.5), l(100, 9.99), l(1, 1.005)];
    const vat = { typed: true as const, types: ['standard', 'standard', 'exempt'] as ('standard' | 'exempt')[] };
    const first = priceInvoiceVat(lines, vat, DATE, mode);
    const again = priceInvoiceVat(first.lines.map((x, i) => l(x.qty, x.price, lines[i]!.discount)), vat, DATE, mode);
    expect(again).toEqual(first);
  });
});

describe('untyped (a company not registered for VAT)', () => {
  it('no VAT, rate 0, the legacy line shape', () => {
    const p = priceInvoiceVat([l(2, 50), l(1, 10, 10)], { typed: false }, DATE, 'exclusive');
    expect(p.lines.map((x) => [x.amount, x.taxAmount, x.vatType, x.taxRate])).toEqual([[100, null, null, 0], [9, null, null, 0]]);
    expect(p.header).toEqual({ subtotal: 109, tax: 0, total: 109, taxRate: 0, amountsAre: 'exclusive' });
  });
  it('inclusive changes nothing: there is no VAT to back out, and it is stored exclusive (#1701)', () => {
    expect(priceInvoiceVat([l(2, 50)], { typed: false }, DATE, 'inclusive').header).toEqual({ subtotal: 100, tax: 0, total: 100, taxRate: 0, amountsAre: 'exclusive' });
  });
});

describe('the page preview (previewInvoiceVat)', () => {
  it('a field mid-edit prices as 0, and an unrated date as untyped, rather than throwing', () => {
    expect(previewInvoiceVat([l(Number.NaN, 10), l(1, 100)], ['standard', 'standard'], DATE, 'exclusive'))
      .toEqual({ subtotal: 100, tax: 15, total: 115 });
    expect(previewInvoiceVat([l(1, 100)], ['standard'], '', 'exclusive')).toEqual({ subtotal: 100, tax: 0, total: 100 });
    expect(previewInvoiceVat([l(1, 100)], null, DATE, 'exclusive')).toEqual({ subtotal: 100, tax: 0, total: 100 });
  });
  it('agrees with priceInvoiceVat for a well-formed form', () => {
    const lines = [l(3, 10), l(7, 33.33, 5)];
    const p = priceInvoiceVat(lines, { typed: true, types: ['standard', 'exempt'] }, DATE, 'inclusive');
    expect(previewInvoiceVat(lines, ['standard', 'exempt'], DATE, 'inclusive'))
      .toEqual({ subtotal: p.header.subtotal, tax: p.header.tax, total: p.header.total });
  });
});

describe('an inclusive back-out never lands on an exact half cent at the South African rates (10, 14, 15%)', () => {
  it('no gross from 0.01 to 2000.00 is a tie (gross x r / (100 + r) is never n + 0.5 cents)', () => {
    // c cents x r / (100 + r) = n + 0.5  <=>  2cr = (2n + 1)(100 + r)  <=>  2cr mod 2(100 + r) = 100 + r
    const ties = [10, 14, 15].flatMap((r) => Array.from({ length: 200000 }, (_, i) => i + 1).filter((c) => (2 * c * r) % (2 * (100 + r)) === 100 + r));
    expect(ties).toEqual([]);
  });
});

describe('round 11 nit b: the derived line amount (qty x price) is guarded', () => {
  const typed = { typed: true as const, types: ['standard' as const] };
  it('a line amount past what NUMERIC(15,2) holds gets no VAT (no float VAT on it, no throw); the total is past the column, which every caller refuses', () => {
    const p = priceInvoiceVat([{ quantity: 99_999_999, unitPrice: 999_999_999 }], typed, '2026-09-15', 'exclusive');
    expect(p.lines[0]!.taxAmount).toBe(0);
    expect(p.header.total).toBeGreaterThanOrEqual(1e13);
  });
  it('an invoice in range is priced as before', () => {
    expect(priceInvoiceVat([{ quantity: 1, unitPrice: 100 }], typed, '2026-09-15', 'exclusive').header).toMatchObject({ subtotal: 100, tax: 15, total: 115 });
  });
  it('the form preview never throws on such a line: it prices as 0', () => {
    expect(previewInvoiceVat([{ quantity: 99_999_999, unitPrice: 999_999_999 }, { quantity: 1, unitPrice: 100 }], ['standard', 'standard'], '2026-09-15', 'exclusive'))
      .toEqual({ subtotal: 100, tax: 15, total: 115 });
  });
});
