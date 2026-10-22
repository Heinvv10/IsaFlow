/**
 * PAYE 4a follow-ups (G1, G2): the certificate type and its tax fields.
 *
 * SARS BRS PAYE Employer Reconciliation V25.3.0 (Jun-26):
 * - p. 17, 3015: an IRP5 needs 4101, 4102 or 4115 > 0 and must not carry 4150;
 *   an IT3(a) must carry 4150 and none of 4101, 4102, 4115.
 * - p. 57, 4115: PAYE on lump sums reported under 3901, 3915, 3920-3924; it is
 *   mandatory when one of those is completed; a 3901-only IRP5 with 4102 = 0
 *   needs 4115 > 0.
 * - p. 58, 4150: 02 = earns less than the tax threshold; 04 = non-taxable
 *   earnings, including nil directives (p. 108), valid from 2024 only with the
 *   directive information completed.
 * - p. 41-44: the directive group is mandatory for 3907 too; 3230 is numeric
 *   only for 3901 and the other fund codes.
 * SARS PAYE-GEN-01-G21 (2027) Rev 1, p. 21: the tax on a 3907 lump sum is
 * reflected under 4102.
 */
import { describe, it, expect } from 'vitest';
import { buildEmployeeRecord, splitCertificateIncome, type EmployeeInput } from '@/modules/accounting/services/payroll/easyFileExportService';
import { validateCertificateTaxFields } from '@/modules/accounting/services/payroll/irp5ValidationEngine';

const base: EmployeeInput = {
  certificateNumber: '712345678920270200000000000001',
  yearOfAssessment: 2027,
  surname: 'Molefe',
  firstNames: 'Thandi',
  initials: 'T',
  idNumber: '9001015009087',
  taxNumber: '0123456789',
  employmentStartDate: '20250301',
  employmentEndDate: null,
  periodsInYoA: 12,
  grossSalary3601: 60_000,
  paye4102: 0,
  uifEmployee: 600,
  uifEmployer: 600,
  sdl4142: 0,
};
const nilDirective = { sourceCode: '3901', directiveNumber: '5550001112', directiveIssuedDate: '20260401', amount: 10_000, paye: 0 };
const otherLumpSum = { sourceCode: '3907', directiveNumber: 'AB12345', directiveIssuedDate: '20260510', amount: 12_000, paye: 3_000 };

describe('certificate type', () => {
  it('nil tax, no directive, under the threshold: IT3(a) with reason 02 and no tax fields', () => {
    const lines = buildEmployeeRecord({ ...base, taxThreshold: 99_000 });
    expect(lines).toContain('3015,"IT3(a)"');
    expect(lines).toContain('4150,02');
    expect(lines.filter(l => /^(4101|4102|4115),/.test(l))).toEqual([]);
    expect(lines).toContain('4141,1200.00');
    expect(validateCertificateTaxFields(lines)).toEqual([]);
  });

  it('nil tax above the threshold, or with no threshold known, is refused: 02 would be a false statement', () => {
    expect(() => buildEmployeeRecord({ ...base, grossSalary3601: 150_000, taxThreshold: 99_000 })).toThrow(/above the tax threshold of R99000.00/);
    expect(() => buildEmployeeRecord({ ...base, grossSalary3601: 90_000, annualPayments3605: 20_000, taxThreshold: 99_000 })).toThrow(/4150/);
    expect(() => buildEmployeeRecord(base)).toThrow(/threshold is not known/);
  });

  it('nil tax under a nil directive, pay under the threshold: IT3(a) with reason 04', () => {
    const lines = buildEmployeeRecord({ ...base, taxThreshold: 99_000, lumpSums: [nilDirective] });
    expect(lines).toContain('3015,"IT3(a)"');
    expect(lines).toContain('4150,04');
    expect(validateCertificateTaxFields(lines)).toEqual([]);
  });

  it('a nil directive beside taxed pay stays an IRP5 with 4115 = 0.00', () => {
    const lines = buildEmployeeRecord({ ...base, paye4102: 1_200, lumpSums: [nilDirective] });
    expect(lines).toContain('3015,"IRP5"');
    expect(lines).toContain('4115,0.00');
    expect(lines.some(l => l.startsWith('4150,'))).toBe(false);
    expect(validateCertificateTaxFields(lines)).toEqual([]);
  });

  it('a 3907 lump sum: its tax is in 4102 (not 4115), its directive number may be alphanumeric', () => {
    const lines = buildEmployeeRecord({ ...base, paye4102: 3_000, lumpSums: [otherLumpSum] });
    expect(lines).toContain('3015,"IRP5"');
    expect(lines).toContain('3907,12000');
    expect(lines).toContain('4102,3000.00');
    expect(lines.some(l => l.startsWith('4115,'))).toBe(false);
    expect(lines).toContain('3230,"AB12345"');
    expect(lines).toContain('3232,3907');
    expect(validateCertificateTaxFields(lines)).toEqual([]);
  });

  it('a 3901 directive number must still be numeric', () => {
    expect(() => buildEmployeeRecord({ ...base, paye4102: 100, lumpSums: [{ ...nilDirective, directiveNumber: 'AB12345' }] }))
      .toThrow(/3230/);
  });
});

describe('validateCertificateTaxFields', () => {
  const codes = (lines: string[]) => validateCertificateTaxFields(lines).map(m => m.code);

  it('an IRP5 with no tax above nil is refused', () => {
    expect(codes(['3015,"IRP5"', '3601,60000', '4102,0.00'])).toContain('IRP5_NO_TAX');
  });
  it('an IRP5 carrying 4150 is refused', () => {
    expect(codes(['3015,"IRP5"', '3601,60000', '4102,10.00', '4150,02'])).toContain('IRP5_WITH_REASON_CODE');
  });
  it('an IT3(a) without 4150, or with a tax field, is refused', () => {
    expect(codes(['3015,"IT3(a)"', '3601,60000'])).toContain('IT3A_WITHOUT_REASON_CODE');
    expect(codes(['3015,"IT3(a)"', '3601,60000', '4150,02', '4102,0.00'])).toContain('IT3A_WITH_TAX_FIELD');
  });
  it('reason 04 needs the directive information', () => {
    expect(codes(['3015,"IT3(a)"', '3601,60000', '4150,04'])).toContain('REASON_04_WITHOUT_DIRECTIVE');
  });
  it('a 3901 on an IRP5 needs 4115', () => {
    expect(codes(['3015,"IRP5"', '3601,60000', '3901,10000', '4102,10.00', '3230,"1"', '3231,20260401', '3232,3901', '3233,10000']))
      .toContain('LUMP_SUM_WITHOUT_4115');
  });
});

describe('splitCertificateIncome by code', () => {
  it('3901 PAYE leaves 4102; 3907 PAYE stays in it; both leave 3601', () => {
    expect(splitCertificateIncome({
      gross: 62_000, paye: 8_115, annualPayments: 0,
      lumpSums: [{ sourceCode: '3901', amount: 30_000, paye: 3_000 }, { sourceCode: '3907', amount: 12_000, paye: 3_000 }],
    })).toEqual({ grossSalary3601: 20_000, annualPayments3605: 0, paye4102: 5_115 });
  });
});
