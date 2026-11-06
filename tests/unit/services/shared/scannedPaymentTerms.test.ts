import { describe, it, expect } from 'vitest';
import { scannedPaymentTermsOption, scannedTermsDueDate } from '@/modules/accounting/services/shared/scannedPaymentTerms';

describe('scannedPaymentTermsOption', () => {
  it.each([
    ['Immediate', 'immediate'], ['COD', 'immediate'], ['0 days', 'immediate'],
    ['Net 30 days', 'net30'], ['60 days from invoice', 'net60'], ['Payable within 90 days', 'net90'],
    ['by arrangement', null], ['', null],
    ['COD on delivery', 'immediate'], ['cash (C.O.D.)', 'immediate'], ['pay on collection of the barcode scanner', null],
    ['decode and pay', null], ['pay immediately', 'immediate'], ['Immediate settlement', 'immediate'], ['0 day', 'immediate'],
    // any net N and any explicit N days up to 999, not only 30 / 60 / 90
    ['10 days', 'net10'], ['Net 45', 'net45'], ['net7', 'net7'], ['14 days from invoice', 'net14'], ['120 days', 'net120'], ['Net 999', 'net999'],
    ['Net 0', 'immediate'], ['Net 1000', null], ['1000 days', null], ['net365000', null],
  ])('%j reads %s', (text, option) => {
    expect(scannedPaymentTermsOption(text)).toBe(option);
  });
});

describe('the wording a supplier really prints', () => {
  it.each([
    ['Nett 30', 'net30'], ['NETT30', 'net30'], ['30-day', 'net30'], ['30-day terms', 'net30'], ['Net 30 days', 'net30'], ['60 days nett', 'net60'],
    ['C.O.D.', 'immediate'], ['c.o.d. on delivery', 'immediate'], ['due on receipt', 'immediate'], ['Payable on receipt', 'immediate'], ['upon receipt', 'immediate'],
    ['cash on delivery', 'immediate'],
  ])('%j reads %s', (text, option) => {
    expect(scannedPaymentTermsOption(text)).toBe(option);
  });

  it.each([
    'Net 30 E.O.M.', 'Net 30 e.o.m', '30 days E.O.M.', 'Net 30 EOM.',                      // a dot after the last letter: no \b there
    'Net 30 after delivery', 'Net 30 following month', 'Net 30 upon completion',          // the "net N" route obeys the same word check
    'Net 150.00', 'Net 150,00', 'Net 2.5 days', '2.5 days',                                // a decimal is an amount
    '50% in 30 days and 50% in 60 days', 'Net 30 days or Net 60 days', '30 days, 60 days', // more than one day count: not the first
    'Net 30, 2% discount', 'Net 30 / 2% 10 days',                                          // any other number
  ])('%j is not terms', (text) => {
    expect(scannedPaymentTermsOption(text)).toBeNull();
  });
});

describe('statement wording is never a netNN (it counts from the month-end, not the invoice date)', () => {
  it.each([
    '90 days after statement', '60 days from statement', 'Net 30 days EOM', '30 days end of month', '30 days from end of the month',
    '30 days month-end', '60 days from statement date', 'Net 30 on statement',
    '30 days from end of next month', 'Net 60 end of month following', 'Net 90 EOM', '45 days EOM',
  ])('%j is ignored', (text) => {
    expect(scannedPaymentTermsOption(text)).toBeNull();
  });
  it('"net" inside a word, a number inside a longer number, and "N days" beside other words are not terms', () => {
    expect(scannedPaymentTermsOption('1300 days')).toBeNull();
    for (const text of ['Internet 7 days', 'Internet 30', 'Cabinet 30', 'Internet access, 30 days contract', 'Subnet 24']) {
      expect(scannedPaymentTermsOption(text), text).toBeNull();
    }
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
