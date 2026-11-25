/**
 * The quote PDF's table and VAT rows (quotePdfVat): a typed quote (migration 1024) prints each line's stored type and
 * VAT and, when its lines mix types, one VAT row per type, each the sum of its lines' stored VAT; a legacy quote prints
 * its rates as before.
 */
import { describe, expect, it } from 'vitest';
import { quotePdfVat, quoteVatByType } from '@/modules/accounting/services/ar/quotePdfVat';
import { fmtZAR } from '@/modules/accounting/services/core/pdfShared';

const R = (n: string) => fmtZAR(Number(n));

const line = (description: string, amount: number, vatType: string | null, tax: number | null, rate: number, extra: Record<string, unknown> = {}) => ({
  description, quantity: '1.00', unit_price: String(amount), amount: String(amount), vat_type: vatType, tax_amount: tax == null ? null : String(tax),
  tax_rate: String(rate), ...extra,
});
const header = (o: Record<string, unknown>) => ({ quote_date: '2026-11-11', tax_rate: '15', amounts_are: 'exclusive', ...o });

describe('quotePdfVat, a typed quote', () => {
  it('mixed types: one VAT row per type, on its own net, in the order the lines show them', () => {
    const lines = [line('A', 100, 'standard', 15, 15), line('B', 50, 'zero_rated', 0, 0), line('C', 40, 'standard', 6, 15), line('D', 30, 'exempt', 0, 0)];
    const v = quotePdfVat(header({ subtotal: '220', tax_amount: '21', total: '241' }), lines);
    expect(v.typed).toBe(true);
    expect(v.head).toEqual(['Description', 'Qty', 'Unit Price (excl. VAT)', 'VAT type', 'VAT', 'Amount (excl. VAT)']);
    expect(v.body[0]).toEqual(['A', '1.00', R('100.00'), 'Standard (15%)', R('15.00'), R('100.00')]);
    expect(v.vatRows).toEqual([
      { label: 'VAT Standard (15%) on ' + R('140.00'), value: R('21.00') },
      { label: 'VAT Zero-rated (0%) on ' + R('50.00'), value: R('0.00') },
      { label: 'VAT Exempt on ' + R('30.00'), value: R('0.00') },
    ]);
    expect(v.disagreement).toBe(0);
  });

  it('one type: one VAT row, the rate quoted', () => {
    const v = quotePdfVat(header({ subtotal: '200', tax_amount: '30', total: '230' }), [line('A', 100, 'standard', 15, 15), line('B', 100, 'standard', 15, 15)]);
    expect(v.vatRows).toEqual([{ label: 'VAT (15%)', value: R('30.00') }]);
  });

  it('inclusive: the unit price is headed incl. VAT and prints as stored', () => {
    const v = quotePdfVat(header({ subtotal: '100', tax_amount: '15', total: '115', amounts_are: 'inclusive' }),
      [line('A', 100, 'standard', 15, 15, { unit_price: '115.00' })]);
    expect(v.head[2]).toBe('Unit Price (incl. VAT)');
    expect(v.body[0]![2]).toBe(R('115.00'));
  });

  it('a header that does not foot to its lines\' VAT is reported, to the cent', () => {
    const v = quotePdfVat(header({ subtotal: '100', tax_amount: '15.50', total: '115.50' }), [line('A', 100, 'standard', 15, 15)]);
    expect(v.disagreement).toBe(0.5);
  });

  it('sums exactly in cents', () => {
    expect(quoteVatByType(Array.from({ length: 10 }, () => line('x', 0.1, 'standard', 0.02, 15)))).toEqual([{ type: 'standard', net: 1, vat: 0.2 }]);
  });
});

describe('quotePdfVat, a legacy quote', () => {
  it('prints the rate table and the label of the rate the lines carry, as before', () => {
    const v = quotePdfVat(header({ subtotal: '200', tax_amount: '15', total: '215' }), [line('A', 100, null, null, 15), line('B', 100, null, null, 0)]);
    expect(v.typed).toBe(false);
    expect(v.head).toEqual(['Description', 'Qty', 'Unit Price', 'VAT Rate', 'Amount']);
    expect(v.body.map((r) => r[3])).toEqual(['15%', '0%']);
    expect(v.vatRows).toEqual([{ label: 'VAT', value: R('15.00') }]);
    expect(v.disagreement).toBe(0);
  });

  it('a partly typed quote prints as legacy', () => {
    const v = quotePdfVat(header({ subtotal: '200', tax_amount: '15', total: '215' }), [line('A', 100, 'standard', 15, 15), line('B', 100, null, null, 0)]);
    expect(v.typed).toBe(false);
  });
});
