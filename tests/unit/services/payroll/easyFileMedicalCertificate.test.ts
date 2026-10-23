/**
 * PAYE 4a follow-ups round 2, R3 (Hein 2026-10-23, option A): the medical
 * fields of the e@syFile record and reason 08.
 *
 * SARS BRS PAYE Employer Reconciliation V25.3.0 (Jun-26):
 * - p. 52-53, 101: 4005 medical scheme fees paid by the employee; cents omitted.
 * - p. 59: 4116 on an IRP5 or IT3(a); "mandatory if any value is completed for
 *   ... 4005"; "must not be completed if there is no value for ... 4005";
 *   may be 0.00.
 * - p. 59-60: 4120 mandatory with 4005 for 65 and older, never under 65.
 * - p. 61: 4150 value 08 "only valid from 2017 year of assessment and if codes
 *   4116 and/ or 4120 has been completed"; IsaFlow gives it only above nil.
 * - p. 108: 08 = "No Tax to be withheld due to Medical Scheme Fees Tax Credit
 *   allowed ... and/or Additional Medical Expenses Tax Credit if employee ≥65".
 */
import { describe, expect, it } from 'vitest';
import { buildEmployeeRecord, type EmployeeInput } from '@/modules/accounting/services/payroll/easyFileExportService';
import { validateCertificateTaxFields } from '@/modules/accounting/services/payroll/irp5ValidationEngine';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import type { PayrollComponent, PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';

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
  grossSalary3601: 360_000,
  paye4102: 40_000,
  uifEmployee: 600,
  uifEmployer: 600,
  sdl4142: 0,
  taxThreshold: 99_000,
};
const medical = { fees: 18_000.75, credit: 9_024, additionalCredit: 0, age65OrOlder: false, recorded: true };
const codes = (lines: string[]) => validateCertificateTaxFields(lines).map(m => m.code);
const at = (lines: string[], code: string) => lines.findIndex(l => l.startsWith(`${code},`));

describe('R3: 4005 / 4116 / 4120 on the certificate', () => {
  it('an IRP5 with medical aid: 4005 (cents dropped) before 4102, 4116 (cents kept) after the tax, no 4120 under 65', () => {
    const lines = buildEmployeeRecord({ ...base, medical });
    expect(lines).toContain('3015,"IRP5"');
    expect(lines).toContain('4005,18000');
    expect(lines).toContain('4116,9024.00');
    expect(at(lines, '4120')).toBe(-1);
    expect(at(lines, '4005')).toBeLessThan(at(lines, '4102'));
    expect(at(lines, '4116')).toBeGreaterThan(at(lines, '4102'));
    expect(at(lines, '4116')).toBeLessThan(at(lines, '4141'));
    expect(validateCertificateTaxFields(lines)).toEqual([]);
  });

  it('65 and older: 4120 beside 4116 (0.00 when no additional credit was allowed)', () => {
    const lines = buildEmployeeRecord({ ...base, medical: { ...medical, age65OrOlder: true } });
    expect(lines).toContain('4120,0.00');
    expect(at(lines, '4120')).toBe(at(lines, '4116') + 1);
    expect(buildEmployeeRecord({ ...base, medical: { ...medical, age65OrOlder: true, additionalCredit: 1_234.5 } })).toContain('4120,1234.50');
  });

  it('credits with no 4005 value: none of the three fields', () => {
    for (const fees of [0, 0.99]) {
      const lines = buildEmployeeRecord({ ...base, medical: { ...medical, fees } });
      expect(lines.filter(l => /^(4005|4116|4120),/.test(l))).toEqual([]);
    }
  });

  it('a year whose latest month predates the credit record: none of the three fields', () => {
    const lines = buildEmployeeRecord({ ...base, medical: { ...medical, recorded: false } });
    expect(lines.filter(l => /^(4005|4116|4120),/.test(l))).toEqual([]);
  });
});

describe('R3: reason 08', () => {
  const nil = { ...base, grossSalary3601: 120_000, paye4102: 0 };

  it('no tax above the threshold because the credit took it: an IT3(a) with 08, 4005 and 4116, valid', () => {
    const lines = buildEmployeeRecord({ ...nil, medical: { ...medical, credit: 3_780 } });
    expect(lines).toContain('3015,"IT3(a)"');
    expect(lines).toContain('4150,08');
    expect(lines).toContain('4116,3780.00');
    expect(lines).toContain('4005,18000');
    expect(at(lines, '4102')).toBe(-1);
    expect(validateCertificateTaxFields(lines)).toEqual([]);
  });

  it('65 and older, the additional credit alone above nil: 08', () => {
    const lines = buildEmployeeRecord({ ...nil, taxThreshold: 153_250, grossSalary3601: 160_000, medical: { ...medical, credit: 0, additionalCredit: 500, age65OrOlder: true } });
    expect(lines).toContain('4150,08');
  });

  it('under the threshold the reason stays 02, and the medical fields are still reported', () => {
    const lines = buildEmployeeRecord({ ...nil, grossSalary3601: 90_000, medical: { ...medical, credit: 1_000 } });
    expect(lines).toContain('4150,02');
    expect(lines).toContain('4116,1000.00');
  });

  it('credits applied but no medical aid deducted through payroll: refused, naming 4005', () => {
    expect(() => buildEmployeeRecord({ ...nil, medical: { ...medical, fees: 0, credit: 3_780 } })).toThrow(/4005/);
    expect(() => buildEmployeeRecord({ ...nil, medical: { ...medical, fees: 0, credit: 3_780 } })).toThrow(/3810/);
    expect(() => buildEmployeeRecord(nil)).toThrow(/4005/);
  });

  it('a nil credit, or credits not recorded, give no reason either: refused', () => {
    expect(() => buildEmployeeRecord({ ...nil, medical: { ...medical, credit: 0 } })).toThrow(/No medical credit took tax off/);
    expect(() => buildEmployeeRecord({ ...nil, medical: { ...medical, recorded: false } })).toThrow(/before IsaFlow recorded/);
  });
});

describe('R3: validateCertificateTaxFields, the medical rules', () => {
  it('4116 or 4120 without 4005 is refused', () => {
    expect(codes(['3015,"IRP5"', '3601,60000', '4102,10.00', '4116,10.00'])).toContain('MEDICAL_CREDIT_WITHOUT_4005');
    expect(codes(['3015,"IRP5"', '3601,60000', '4102,10.00', '4120,0.00'])).toContain('MEDICAL_CREDIT_WITHOUT_4005');
  });
  it('4005 without 4116 is refused', () => {
    expect(codes(['3015,"IRP5"', '3601,60000', '4005,1000', '4102,10.00'])).toContain('MEDICAL_FEES_WITHOUT_4116');
  });
  it('08 needs a credit above nil', () => {
    expect(codes(['3015,"IT3(a)"', '3601,60000', '4005,1000', '4116,0.00', '4150,08'])).toContain('REASON_08_WITHOUT_MEDICAL_CREDIT');
    expect(codes(['3015,"IT3(a)"', '3601,60000', '4150,08'])).toContain('REASON_08_WITHOUT_MEDICAL_CREDIT');
    expect(codes(['3015,"IT3(a)"', '3601,60000', '4005,1000', '4116,0.00', '4120,5.00', '4150,08'])).toEqual([]);
  });
});

describe('R3: the calculator counts medical scheme fees from deductions coded 4005', () => {
  const comp = (code: string, componentType: PayrollComponent['componentType']): PayrollComponent => ({
    id: `c-${code}-${componentType}`, name: code, sarsSourceCode: code, componentType, isTaxable: componentType === 'earning',
    isUifApplicable: true, isSdlApplicable: true,
  });
  const employee = { id: 'e1', dateOfBirth: new Date(1985, 0, 1), startDate: new Date(2015, 0, 1), uifExcluded: true, medicalAidMainMember: true, medicalAidDependantsCount: 0 } as unknown as PayrollEmployee;
  it('a deduction coded 4005 (whitespace stripped) counts; an employer contribution or another code does not', () => {
    const line = calculatePayrollLine({
      employee, period: { year: 2026, month: 3 }, taxYear: 2027, annualPayrollEstimate: 'defer',
      components: [
        { component: comp('3601', 'earning'), amount: 20_000 },
        { component: comp('4005', 'deduction'), amount: 1_500 },
        { component: { ...comp('4005', 'deduction'), id: 'c2', sarsSourceCode: ' 4005\t' }, amount: 250.5 },
        { component: comp('4005', 'employer_contribution'), amount: 900 },
        { component: comp('4001', 'deduction'), amount: 700 },
        { component: comp('14005', 'deduction'), amount: 333 },
      ],
    });
    expect(line.medicalSchemeFees).toBe(1_750.5);
  });
});
