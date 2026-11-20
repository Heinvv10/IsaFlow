/**
 * The invoice pages' VAT until the line-level screen (formVat): the form's one rate types every line as the server's
 * legacy header contract does, the summary is the shared per-line pricing (the figure create stores), and a company not
 * registered for VAT prices and sends no VAT.
 */
import { describe, expect, it } from 'vitest';
import { formLineType, formTotals, vatModeFor } from '@/components/accounting/customer-invoices/formVat';
import { priceInvoiceVat } from '@/modules/accounting/services/ar/invoiceLineVatPricing';

const l = (quantity: number, unitPrice: number, discount = 0) => ({ quantity, unitPrice, discount });

describe('formLineType', () => {
  it('the standard rate on the date is standard, 0 is zero_rated, anything else none', () => {
    expect(formLineType(15, '2026-11-20')).toBe('standard');
    expect(formLineType(14, '2018-03-31')).toBe('standard');
    expect(formLineType(0, '2026-11-20')).toBe('zero_rated');
    expect(formLineType(14, '2026-11-20')).toBeNull();
    expect(formLineType(15, '')).toBeNull();
  });
});

describe('formTotals', () => {
  it('is the per-line pricing create stores: seven lines of 14.29 carry VAT 14.98', () => {
    const lines = Array.from({ length: 7 }, () => l(1, 14.29));
    expect(formTotals(lines, 15, 'exclusive', '2026-11-20')).toEqual({ subtotal: 100.03, tax: 14.98, total: 115.01 });
    const stored = priceInvoiceVat(lines, { typed: true, types: Array(7).fill('standard') }, '2026-11-20', 'exclusive').header;
    expect(formTotals(lines, 15, 'exclusive', '2026-11-20')).toEqual({ subtotal: stored.subtotal, tax: stored.tax, total: stored.total });
  });
  it('a rate the server refuses is shown as typed, VAT on the subtotal', () => {
    expect(formTotals([l(1, 100)], 14, 'exclusive', '2026-11-20')).toEqual({ subtotal: 100, tax: 14, total: 114 });
  });
  it('a field mid-edit prices as 0', () => {
    expect(formTotals([l(Number.NaN, 5), l(2, 50)], 15, 'exclusive', '2026-11-20')).toEqual({ subtotal: 100, tax: 15, total: 115 });
  });
});

describe('vatModeFor', () => {
  it('a company not registered for VAT prices at no VAT whatever is picked', () => {
    expect(vatModeFor(false, 'exclusive')).toBe('none');
    expect(vatModeFor(false, 'inclusive')).toBe('none');
    expect(vatModeFor(true, 'inclusive')).toBe('inclusive');
  });
});
