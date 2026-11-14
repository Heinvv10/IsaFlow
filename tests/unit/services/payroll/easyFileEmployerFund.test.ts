/**
 * Wave 5 RF: an employer's retirement fund contribution on the e@syFile record. SARS BRS PAYE Employer Reconciliation V25.3.0:
 * - p. 94-95: 3817 / 3825 / 3828, the taxable benefit of the employer's pension / provident / retirement annuity contributions
 *   (the certificate's non-cash income, payrollNonCashFiling);
 * - p. 101-102: 4001 / 4003 / 4006 are contributions "paid and 'deemed paid' by employee", the deemed part being that benefit;
 * - p. 103: 4472 / 4473 / 4475, the employer's contributions; p. 55: "If code 4472 is completed, then code 3817 ... and code
 *   4001 must be completed" (likewise 4473 with 3825 and 4003, 4475 with 3828 and 4006);
 * - p. 57: 4497 totals every 40xx / 44xx / 45xx value.
 */
import { describe, expect, it } from 'vitest';
import { buildEmployeeRecord, type EmployeeInput } from '@/modules/accounting/services/payroll/easyFileExportService';
import { validateCertificateTaxFields } from '@/modules/accounting/services/payroll/irp5ValidationEngine';

const base: EmployeeInput = {
  certificateNumber: '712345678920270200000000000001', yearOfAssessment: 2027, surname: 'Molefe', firstNames: 'Thandi',
  initials: 'T', idNumber: '9001015009087', taxNumber: '0123456789', employmentStartDate: '20250301', employmentEndDate: null,
  periodsInYoA: 12, grossSalary3601: 240_000, paye4102: 18_198, uifEmployee: 2_125.44, uifEmployer: 2_125.44, sdl4142: 2_400,
  taxThreshold: 99_000,
};
const value = (lines: string[], code: string) => lines.find((l) => l.startsWith(`${code},`))?.split(',')[1];
const at = (lines: string[], code: string) => lines.findIndex((l) => l.startsWith(`${code},`));

describe('the employer pension contribution (3817) on the certificate', () => {
  // A year of the oracle case: R20 000 a month, 4001 R4 000 a month, the employer's 15% of RFI R3 000 a month.
  const lines = buildEmployeeRecord({
    ...base,
    retirementFund: { pension4001: 48_000, provident4003: 0, annuity4006: 0, donations4030: 0 },
    fringeBenefits: [{ sourceCode: '3817', amount: 36_000 }],
  });

  it('3817 is the benefit, 4472 the employer\'s contribution equal to it, and 4001 paid plus deemed paid', () => {
    expect(value(lines, '3817')).toBe('36000');
    expect(value(lines, '4472')).toBe('36000');
    expect(value(lines, '4001')).toBe(String(48_000 + 36_000));
  });

  it('4497 totals 4001 and 4472, in code order, and the record validates', () => {
    expect(value(lines, '4497')).toBe(String(84_000 + 36_000));
    expect(at(lines, '4001')).toBeLessThan(at(lines, '4102'));
    expect(at(lines, '4472')).toBeLessThan(at(lines, '4497'));
    expect(validateCertificateTaxFields(lines)).toEqual([]);
  });
});

describe('provident and retirement annuity, alone', () => {
  it('3825 → 4473 and 4003; 3828 → 4475 and 4006, with no employee contribution of its own; 4472-4475 in code order around 4474', () => {
    const lines = buildEmployeeRecord({
      ...base,
      fringeBenefits: [{ sourceCode: '3810', amount: 12_000 }, { sourceCode: '3825', amount: 6_000.75 }, { sourceCode: '3828', amount: 2_400 }],
      medical: { fees: 12_000, credit: 9_024, additionalCredit: 0, age65OrOlder: false, recorded: true },
    });
    expect([value(lines, '4473'), value(lines, '4003'), value(lines, '4475'), value(lines, '4006'), value(lines, '4474')])
      .toEqual(['6000', '6000', '2400', '2400', '12000']);
    expect(value(lines, '4472')).toBeUndefined();
    expect(value(lines, '4001')).toBeUndefined();
    expect(at(lines, '4473')).toBeLessThan(at(lines, '4474'));
    expect(at(lines, '4474')).toBeLessThan(at(lines, '4475'));
  });

  it('without an employer fund benefit the record is unchanged: no 4472 / 4473 / 4475', () => {
    const lines = buildEmployeeRecord({ ...base, retirementFund: { pension4001: 48_000, provident4003: 0, annuity4006: 0, donations4030: 0 } });
    expect(lines.some((l) => /^44(72|73|75),/.test(l))).toBe(false);
    expect(value(lines, '4001')).toBe('48000');
  });
});
