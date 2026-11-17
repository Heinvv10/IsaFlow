/** Wave 6 EFa: the filing reference is SARS's PRN for the form, nothing else (filingReference.ts). */
import { describe, expect, it } from 'vitest';
import { parseFilingReference } from '@/modules/accounting/services/returns/filingReference';

describe('parseFilingReference', () => {
  it('takes a VAT201 PRN (VAT number starting 4) and an EMP201 PRN (PAYE reference starting 7), trimmed and upper-cased', () => {
    expect(parseFilingReference('VAT201', ' 4123456789v00000001 ')).toBe('4123456789V00000001');
    expect(parseFilingReference('EMP201', '7123456789L00000001')).toBe('7123456789L00000001');
  });

  it.each([
    ['VAT201', '7123456789V00000001'], // a PAYE reference on a VAT return
    ['EMP201', '4123456789L00000001'], // a VAT number on an EMP201
    ['VAT201', '4123456789V0000001'], // 18 characters
    ['VAT201', '4123456789V000000011'], // 20 characters
    ['VAT201', '4123456789 V00000001'], // a space inside
    ['VAT201', '412345678XV00000001'], // a letter in the tax number
    ['VAT201', '4123456789700000001'], // no tax-type letter
    ['VAT201', 'SARS-REF-1'],
    ['VAT201', `4123456789V0000000${String.fromCharCode(0)}`],
    ['VAT201', '４123456789V00000001'], // a full-width digit
  ] as const)('%s refuses %j (400, FILING_REFERENCE_SHAPE)', (form, raw) => {
    expect(() => parseFilingReference(form, raw)).toThrow(expect.objectContaining({ status: 400, refusalCode: 'FILING_REFERENCE_SHAPE' }));
  });
});
