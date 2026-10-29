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
  assertEndNotBeforeNextRun,
  editTotals,
  effectiveNextRunDate,
  parseEndDateEdit,
  parseTaxRate,
  RecurringInvoiceEditError,
  resolveEditTaxRate,
} from '@/modules/accounting/services/ar/recurringInvoiceEdit';
import { RecurringInvoiceLockTimeoutError } from '@/modules/accounting/services/ar/recurringInvoiceLock';

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

describe('tax rate scale (tax_rate is NUMERIC(5,2))', () => {
  it.each([7.555, '7.555', 0.001, 14.999, 15.001])('refuses %j: it would round differently in the column', (v) => {
    expect(() => parseTaxRate(v)).toThrow(RecurringInvoiceEditError);
    expect(() => resolveEditTaxRate(v, '15.00')).toThrow(/2 decimal/);
  });

  it.each([[7.55, 7.55], ['7.5', 7.5], [14.5, 14.5], [1.15, 1.15], [0.07, 0.07], [100, 100], [0, 0]])(
    'accepts %j', (v, expected) => {
      expect(parseTaxRate(v)).toBe(expected);
    });
});

describe('effectiveNextRunDate', () => {
  it('prefers a next run date in the body, reading only its date part', () => {
    expect(effectiveNextRunDate('2027-05-01', '2027-01-01')).toBe('2027-05-01');
    expect(effectiveNextRunDate('2027-05-01T00:00:00.000Z', '2027-01-01')).toBe('2027-05-01');
  });

  it('falls back to the stored date (string or Date) when the body sends none', () => {
    expect(effectiveNextRunDate(undefined, '2027-01-01')).toBe('2027-01-01');
    expect(effectiveNextRunDate('', new Date(2027, 0, 1))).toBe('2027-01-01');
  });
});

describe('assertEndNotBeforeNextRun', () => {
  it('refuses an End Date before the next run', () => {
    expect(() => assertEndNotBeforeNextRun('2027-01-31', '2027-02-01')).toThrow(RecurringInvoiceEditError);
  });

  it('allows the same day, a later day, and clearing', () => {
    expect(() => assertEndNotBeforeNextRun('2027-02-01', '2027-02-01')).not.toThrow();
    expect(() => assertEndNotBeforeNextRun('2027-03-01', '2027-02-01')).not.toThrow();
    expect(() => assertEndNotBeforeNextRun(null, '2027-02-01')).not.toThrow();
  });
});

describe('RecurringInvoiceLockTimeoutError', () => {
  it('says an edit is blocked by another request, not that the template is being run', () => {
    const edit = new RecurringInvoiceLockTimeoutError('ri-1', 'edit');
    expect(edit.message).not.toMatch(/being run/);
    expect(edit.message).toMatch(/edit/i);
    expect(edit.code).toBe('RECURRING_INVOICE_LOCK_TIMEOUT');
  });

  it('keeps the run wording by default', () => {
    expect(new RecurringInvoiceLockTimeoutError('ri-1').message).toMatch(/being run by another request/);
  });
});
