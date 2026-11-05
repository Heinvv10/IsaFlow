/**
 * paymentTerms.ts — the due date a contact's terms give an invoice date, and the one parser of a terms write.
 * Local-date arithmetic, so the result never slips a day across UTC.
 */
import { describe, expect, it } from 'vitest';
import {
  PaymentTermsError, describePaymentTerms, dueDateFromTerms, parseTermsWrite,
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
    ['no type', '2026-10-01', 30, null],
    ['no invoice date', '', 30, 'invoice_days'],
    ['an impossible invoice date', '2026-02-30', 30, 'invoice_days'],
    ['an impossible invoice date with months', '2026-13-01', 1, 'statement_months'],
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

  it('reads a number sent alone as invoice days (callers that predate the type)', () => {
    expect(parseTermsWrite(45, undefined)).toEqual({ kind: 'set', days: 45, type: 'invoice_days' });
    expect(parseTermsWrite(45, null)).toEqual({ kind: 'set', days: 45, type: 'invoice_days' });
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
    [30, null, 'Not set'],
  ])('%s %s reads %s', (n, type, text) => {
    expect(describePaymentTerms(n, type)).toBe(text);
  });
});
