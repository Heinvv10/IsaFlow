/**
 * paymentTerms.ts — the due date a contact's terms give an invoice date, and the one parser of a terms write.
 * Local-date arithmetic, so the result never slips a day across UTC.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { log } from '@/lib/logger';
import {
  FALLBACK_COMPANY_TERMS, companyTermsFromSetting, PaymentTermsError, describeContactTerms, describePaymentTerms, dueDateFromTerms, dueDateWithDefault, effectiveTerms,
  ownTermsDueDate, parseTermsWrite,
} from '@/modules/accounting/services/shared/paymentTerms';

describe('dueDateFromTerms: invoice_days', () => {
  it.each([
    ['2026-01-31', 30, '2026-03-02'],
    ['2026-10-01', 30, '2026-10-31'],
    ['2026-09-16', 90, '2026-12-15'],
    ['2026-10-01', 0, '2026-10-01'],
    ['2028-02-28', 1, '2028-02-29'],
    ['2026-12-20', 30, '2027-01-19'],
  ])('%s + %i days = %s', (invoiceDate, n, due) => {
    expect(dueDateFromTerms(invoiceDate, n, 'invoice_days')).toBe(due);
  });
});

describe('dueDateFromTerms: statement_days (month-end of the invoice month + N)', () => {
  it.each([
    ['2028-02-15', 0, '2028-02-29'],
    ['2026-02-15', 0, '2026-02-28'],
    ['2026-10-15', 30, '2026-11-30'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2026-10-31', 0, '2026-10-31'],
  ])('%s + %i days after statement = %s', (invoiceDate, n, due) => {
    expect(dueDateFromTerms(invoiceDate, n, 'statement_days')).toBe(due);
  });
});

describe('dueDateFromTerms: statement_months (month-end of the Nth month after the invoice month)', () => {
  it.each([
    ['2026-08-16', 3, '2026-11-30'],
    ['2026-09-16', 3, '2026-12-31'],
    ['2026-08-16', 0, '2026-08-31'],
    ['2026-01-31', 1, '2026-02-28'],
    ['2028-01-31', 1, '2028-02-29'],
    ['2026-11-05', 2, '2027-01-31'],
    ['2026-12-31', 1, '2027-01-31'],
    ['2026-10-15', 14, '2027-12-31'],
  ])('%s + %i months after statement = %s', (invoiceDate, n, due) => {
    expect(dueDateFromTerms(invoiceDate, n, 'statement_months')).toBe(due);
  });
});

describe('dueDateFromTerms: a number with no type (what the pre-960 code wrote as (30, NULL))', () => {
  it.each([[null], [undefined], ['']])('reads type %j as invoice days', (type) => {
    expect(dueDateFromTerms('2026-10-01', 30, type)).toBe('2026-10-31');
  });
  it('but a type nobody defined is still no date', () => {
    expect(dueDateFromTerms('2026-10-01', 30, 'junk')).toBeNull();
  });
});

describe('dueDateFromTerms: legacy type names', () => {
  it('reads days as invoice_days and end_of_month as statement_days', () => {
    expect(dueDateFromTerms('2026-10-01', 30, 'days')).toBe('2026-10-31');
    expect(dueDateFromTerms('2026-10-15', 30, 'end_of_month')).toBe('2026-11-30');
  });
});

describe('dueDateFromTerms: no date', () => {
  it.each([
    ['null terms', '2026-10-01', null, 'invoice_days'],
    ['undefined terms', '2026-10-01', undefined, 'invoice_days'],
    ['negative terms', '2026-10-01', -1, 'invoice_days'],
    ['fractional terms', '2026-10-01', 1.5, 'statement_months'],
    ['NaN terms', '2026-10-01', Number.NaN, 'invoice_days'],
    ['terms too large to be a date', '2026-10-01', 2_000_000_000, 'invoice_days'],
    ['months too large to be a date', '2026-10-01', 2_000_000_000, 'statement_months'],
    ['a type nobody defined', '2026-10-01', 30, 'net'],
    ['no invoice date', '', 30, 'invoice_days'],
    ['an impossible invoice date', '2026-02-30', 30, 'invoice_days'],
    ['an impossible invoice date with months', '2026-13-01', 1, 'statement_months'],
    ['more than the 999 the forms accept', '2026-10-01', 1000, 'invoice_days'],
  ])('%s gives no due date', (_why, invoiceDate, n, type) => {
    expect(dueDateFromTerms(invoiceDate, n, type)).toBeNull();
  });
});

describe('parseTermsWrite', () => {
  it('leaves terms alone when neither field is sent', () => {
    expect(parseTermsWrite(undefined, undefined)).toEqual({ kind: 'leave' });
    expect(parseTermsWrite(null, null)).toEqual({ kind: 'leave' });
  });

  it('sets days with their type, normalising legacy names', () => {
    expect(parseTermsWrite(0, 'invoice_days')).toEqual({ kind: 'set', days: 0, type: 'invoice_days' });
    expect(parseTermsWrite(3, 'statement_months')).toEqual({ kind: 'set', days: 3, type: 'statement_months' });
    expect(parseTermsWrite(30, 'days')).toEqual({ kind: 'set', days: 30, type: 'invoice_days' });
    expect(parseTermsWrite(30, 'end_of_month')).toEqual({ kind: 'set', days: 30, type: 'statement_days' });
  });

  it('reads a number sent alone as days only: the stored type is kept (a create reads it as invoice days)', () => {
    expect(parseTermsWrite(45, undefined)).toEqual({ kind: 'days_only', days: 45 });
    expect(parseTermsWrite(45, null)).toEqual({ kind: 'days_only', days: 45 });
  });

  it('clears terms on the explicit not_set type', () => {
    expect(parseTermsWrite(undefined, 'not_set')).toEqual({ kind: 'clear' });
    expect(parseTermsWrite(null, 'not_set')).toEqual({ kind: 'clear' });
  });

  it.each([
    ['not_set with a number', 30, 'not_set'],
    ['a type without a number', undefined, 'statement_days'],
    ['an unknown type', 30, 'net30'],
    ['a negative number', -1, 'invoice_days'],
    ['a fractional number', 1.5, 'invoice_days'],
    ['NaN', Number.NaN, 'invoice_days'],
    ['a number over the cap', 1000, 'invoice_days'],
  ])('refuses %s', (_why, days, type) => {
    expect(() => parseTermsWrite(days, type)).toThrow(PaymentTermsError);
  });
});

describe('effectiveTerms / dueDateWithDefault / describeContactTerms', () => {
  const company = { days: 2, type: 'statement_months' } as const;
  it('own terms win; none uses the company default; unreadable ones use it too', () => {
    expect(effectiveTerms(10, 'invoice_days', company)).toEqual({ days: 10, type: 'invoice_days', own: true });
    expect(effectiveTerms(null, null, company)).toEqual({ days: 2, type: 'statement_months', own: false });
    expect(effectiveTerms(-1, 'days', company).own).toBe(false);
    expect(effectiveTerms(30, 'junk', company).own).toBe(false);
  });
  it('the company default is 30 days from invoice when none is given', () => {
    expect(dueDateWithDefault('2026-10-01', null, null)).toBe('2026-10-31');
  });
  it('dates a document by the contact, else the company', () => {
    expect(dueDateWithDefault('2026-10-15', 7, 'invoice_days', company)).toBe('2026-10-22');
    expect(dueDateWithDefault('2026-10-15', null, null, company)).toBe('2026-12-31');
  });
  it('says the terms are not confirmed when it falls back', () => {
    expect(describeContactTerms(null, null, company)).toBe('Terms not confirmed — using company default (2 months after statement)');
    expect(describeContactTerms(null, null)).toBe('Terms not confirmed — using company default (30 days from invoice date)');
    expect(describeContactTerms(0, 'invoice_days', company)).toBe('Immediate');
  });
});

describe('ownTermsDueDate', () => {
  it.each([
    ['net30', '2026-03-15', '2026-04-14'], ['Net 60', '2026-12-20', '2027-02-18'], ['immediate', '2026-08-16', '2026-08-16'],
    [' Immediate ', '2026-08-16', '2026-08-16'], ['by arrangement', '2026-08-16', null], ['', '2026-08-16', null], [null, '2026-08-16', null],
    ['Internet 7 days', '2026-08-16', null], ['Cabinet 30', '2026-08-16', null], ['net365000', '2026-08-16', null], ['net 1000', '2026-08-16', null],
    ['net999', '2026-01-01', '2028-09-26'], ['net-30', '2026-08-16', null],
  ])('%j on %s gives %s', (text, date, due) => {
    expect(ownTermsDueDate(date, text)).toBe(due);
  });
});

describe('describePaymentTerms', () => {
  it.each([
    [0, 'invoice_days', 'Immediate'],
    [1, 'invoice_days', '1 day from invoice date'],
    [30, 'invoice_days', '30 days from invoice date'],
    [0, 'statement_days', 'End of the invoice month'],
    [30, 'statement_days', '30 days after statement'],
    [1, 'statement_months', '1 month after statement'],
    [3, 'statement_months', '3 months after statement'],
    [30, 'days', '30 days from invoice date'],
    [30, 'end_of_month', '30 days after statement'],
    [null, null, 'Not set'],
    [null, 'invoice_days', 'Not set'],
    [30, null, '30 days from invoice date'],
    [1500, 'invoice_days', 'Not set'],
    [30, 'junk', 'Not set'],
  ])('%s %s reads %s', (n, type, text) => {
    expect(describePaymentTerms(n, type)).toBe(text);
  });
});

describe('companyTermsFromSetting: an unreadable stored default falls back to 30 days and says so', () => {
  beforeEach(() => { vi.mocked(log.warn).mockClear(); });

  it.each([['not json'], ['{"days":-1}'], ['{"days":30,"type":"weekly"}'], ['null'], ['{"days":1000,"type":"invoice_days"}']])(
    '%j gives FALLBACK_COMPANY_TERMS and a warning with the company id', (stored) => {
      expect(companyTermsFromSetting(stored, 'co-77')).toEqual(FALLBACK_COMPANY_TERMS);
      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(vi.mocked(log.warn).mock.calls[0]![1]).toEqual({ companyId: 'co-77' });
    });

  it.each([[null], [undefined], [''], [42]])('%j (no row / not text) is the quiet fallback: nothing to warn about', (stored) => {
    expect(companyTermsFromSetting(stored, 'co-77')).toEqual(FALLBACK_COMPANY_TERMS);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('a readable value is used and not warned about', () => {
    expect(companyTermsFromSetting('{"days":2,"type":"statement_months"}', 'co-77')).toEqual({ days: 2, type: 'statement_months' });
    expect(log.warn).not.toHaveBeenCalled();
  });
});
