/** Wave 6 EFa: the filing reference is SARS's PRN for the form, nothing else (filingReference.ts). */
import { describe, expect, it } from 'vitest';
import { parseFilingReference } from '@/modules/accounting/services/returns/filingReference';

describe('parseFilingReference', () => {
  it('takes a VAT201 PRN (VAT number starting 4) and an EMP201 PRN (PAYE reference starting 7), trimmed and upper-cased', () => {
    expect(parseFilingReference('VAT201', ' 4123456789v00000001 ')).toBe('4123456789V00000001');
    expect(parseFilingReference('EMP201', '7123456789L00000001')).toBe('7123456789L00000001');
  });

  it('C: drops spaces and dashes anywhere, as a PRN is printed grouped', () => {
    expect(parseFilingReference('VAT201', '4123456789 V 20260300')).toBe('4123456789V20260300');
    expect(parseFilingReference('VAT201', '4123456789-V-20260300')).toBe('4123456789V20260300');
    expect(parseFilingReference('VAT201', '412 345 6789\tv2026-0300')).toBe('4123456789V20260300');
    // L1 (review r2): Unicode hyphens and dashes U+2010-2015 and the minus sign U+2212, as a word processor types them.
    for (const dash of ['\u2010', '\u2011', '\u2012', '\u2013', '\u2014', '\u2015', '\u2212']) {
      expect(parseFilingReference('VAT201', `4123456789${dash}V${dash}20260300`), dash.codePointAt(0)!.toString(16)).toBe('4123456789V20260300');
    }
  });

  it('EMP201, UNVERIFIED shape: one letter and 8 digits, or two letters, YYMM and 3 digits', () => {
    expect(parseFilingReference('EMP201', '7123456789LC2608000')).toBe('7123456789LC2608000');
    expect(parseFilingReference('EMP201', '7123456789 lc 2608 000')).toBe('7123456789LC2608000');
  });

  it.each([
    ['VAT201', '7123456789V00000001'], // a PAYE reference on a VAT return
    ['EMP201', '4123456789L00000001'], // a VAT number on an EMP201
    ['VAT201', '4123456789V0000001'], // 18 characters
    ['VAT201', '4123456789V000000011'], // 20 characters
    ['VAT201', '412345678XV00000001'], // a letter in the tax number
    ['VAT201', '4123456789700000001'], // no tax-type letter
    ['VAT201', 'SARS-REF-1'],
    ['VAT201', `4123456789V0000000${String.fromCharCode(0)}`],
    ['VAT201', '４123456789V00000001'], // a full-width digit
    ['VAT201', '4123456789VA0000001'], // the EMP201's two-letter shape is not a VAT201's
    ['EMP201', '7123456789L0000001'], // one letter and 7 digits: 18 characters
    ['EMP201', '7123456789LCX000001'], // three letters
    ['VAT201', '4123456789_V00000001'], // only spaces and dashes are dropped
  ] as const)('%s refuses %j (400, FILING_REFERENCE_SHAPE)', (form, raw) => {
    expect(() => parseFilingReference(form, raw)).toThrow(expect.objectContaining({ status: 400, refusalCode: 'FILING_REFERENCE_SHAPE' }));
  });
});
