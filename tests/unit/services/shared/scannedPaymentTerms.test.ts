import { describe, it, expect } from 'vitest';
import { scannedPaymentTermsOption, scannedTermsDueDate } from '@/modules/accounting/services/shared/scannedPaymentTerms';

describe('scannedPaymentTermsOption', () => {
  it.each([
    ['Immediate', 'immediate'], ['COD', 'immediate'], ['0 days', 'immediate'],
    ['Net 30 days', 'net30'], ['60 days from invoice', 'net60'], ['Payable within 90 days', 'net90'],
    ['by arrangement', null], ['', null],
    ['COD on delivery', 'immediate'], ['cash (C.O.D.)', null], ['pay on collection of the barcode scanner', null],
    ['decode and pay', null], ['pay immediately', 'immediate'], ['Immediate settlement', 'immediate'], ['0 day', 'immediate'], ['10 days', null],
  ])('%j reads %s', (text, option) => {
    expect(scannedPaymentTermsOption(text)).toBe(option);
  });
});

describe('statement wording is never a netNN (it counts from the month-end, not the invoice date)', () => {
  it.each([
    '90 days after statement', '60 days from statement', 'Net 30 days EOM', '30 days end of month', '30 days from end of the month',
    '30 days month-end', '60 days from statement date', 'Net 30 on statement',
  ])('%j is ignored', (text) => {
    expect(scannedPaymentTermsOption(text)).toBeNull();
  });
  it('a number inside a longer number is not terms', () => {
    expect(scannedPaymentTermsOption('130 days')).toBeNull();
    expect(scannedPaymentTermsOption('Internet 7 days')).toBeNull();
  });
});

describe('scannedTermsDueDate', () => {
  it.each([
    ['2026-09-16', 'Net 90 days', '2026-12-15'], ['2026-09-16', '90 days after statement', null], ['2026-09-16', 'immediate', '2026-09-16'],
    ['2026-09-16', 'by arrangement', null], ['2026-09-16', '', null], ['2026-09-16', null, null],
  ])('%s %j gives %s', (date, text, due) => {
    expect(scannedTermsDueDate(date, text)).toBe(due);
  });
});
