/**
 * Recurring-invoice PUT: the pure pieces of an edit.
 *
 *  - End Date: a body WITHOUT the key keeps the stored value; the key with
 *    null / '' clears it; a real date sets it; anything else is refused.
 *  - Tax basis: an edit that omits taxRate keeps the template's STORED rate.
 *    It must never fall back to 15 — a 0% template edited without taxRate used
 *    to get 15% tax on its header while tax_rate stayed 0, so the run refused
 *    it ("totals disagree with its lines").
 */
import { describe, expect, it } from 'vitest';
import {
  editTotals,
  parseEndDateEdit,
  RecurringInvoiceEditError,
  resolveEditTaxRate,
} from '@/modules/accounting/services/ar/recurringInvoiceEdit';

describe('parseEndDateEdit', () => {
  it('leaves the stored value alone when the key is absent', () => {
    expect(parseEndDateEdit({ id: 'x', templateName: 'T' })).toEqual({ provided: false, value: null });
  });

  it.each([null, '', '   '])('clears the date for %j', (v) => {
    expect(parseEndDateEdit({ endDate: v })).toEqual({ provided: true, value: null });
  });

  it('sets a valid YYYY-MM-DD date', () => {
    expect(parseEndDateEdit({ endDate: '2027-03-31' })).toEqual({ provided: true, value: '2027-03-31' });
  });

  it('treats an explicit undefined like an absent key (JSON cannot carry it)', () => {
    expect(parseEndDateEdit({ endDate: undefined })).toEqual({ provided: false, value: null });
  });

  it.each(['2027-02-30', '2027-13-01', 'tomorrow', '31/03/2027', '2027-3-1', 20270331, true])(
    'refuses %j', (v) => {
      expect(() => parseEndDateEdit({ endDate: v })).toThrow(RecurringInvoiceEditError);
    });
});

describe('resolveEditTaxRate', () => {
  it('keeps a stored 0% rate when taxRate is omitted (the 15% default bug)', () => {
    expect(resolveEditTaxRate(undefined, '0.00')).toBe(0);
    expect(resolveEditTaxRate(null, 0)).toBe(0);
  });

  it('keeps a stored non-standard rate when taxRate is omitted', () => {
    expect(resolveEditTaxRate(undefined, '14.00')).toBe(14);
  });

  it('uses an explicit rate, including an explicit 0', () => {
    expect(resolveEditTaxRate(0, '15.00')).toBe(0);
    expect(resolveEditTaxRate(15, '0.00')).toBe(15);
    expect(resolveEditTaxRate('7.5', '15.00')).toBe(7.5);
  });

  it.each([-1, 100.01, Number.NaN, 'abc', '', true, {}])('refuses a requested rate of %j', (v) => {
    expect(() => resolveEditTaxRate(v, '15.00')).toThrow(RecurringInvoiceEditError);
  });

  it('refuses rather than defaulting when no rate was sent and none is stored', () => {
    expect(() => resolveEditTaxRate(undefined, null)).toThrow(RecurringInvoiceEditError);
    expect(() => resolveEditTaxRate(undefined, 'n/a')).toThrow(RecurringInvoiceEditError);
  });
});

describe('editTotals', () => {
  const lines = [{ quantity: 2, unitPrice: 500 }, { quantity: 1, unitPrice: 250 }];

  it('adds tax at the given rate', () => {
    expect(editTotals(lines, 15)).toEqual({ subtotal: 1250, taxAmount: 187.5, totalAmount: 1437.5 });
  });

  it('adds no tax at 0%', () => {
    expect(editTotals(lines, 0)).toEqual({ subtotal: 1250, taxAmount: 0, totalAmount: 1250 });
  });

  it('rounds tax to cents once, as create does', () => {
    expect(editTotals([{ quantity: 1, unitPrice: 33.33 }], 15).taxAmount).toBe(5);
  });
});
