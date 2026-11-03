/**
 * Non-cash fringe benefits on the e@syFile certificate and the EMP501 CSV (Hein 2026-11-03: under
 * their own SARS code, never inside 3601).
 *
 * SARS PAYE-AE-06-G06 (2026, Rev 13, p. 16; 2027, Rev 14, p. 16): 3801 "General fringe benefits"
 * includes "low interest or interest free loans and subsidies" (3807 folded into 3801 from 2010).
 * SARS BRS PAYE Employer Reconciliation (V25.2.0, Apr-26) section 3: (j) cents omitted on income
 * codes, (i) a zero field is left out, (p) at least one income code above zero; file layout:
 * "Income received" 3601 to 3835 are N15 income codes.
 */
import { describe, it, expect } from 'vitest';
import { buildEmployeeRecord, type EmployeeInput } from '@/modules/accounting/services/payroll/easyFileExportService';
import { buildEmp501Csv } from '@/../pages/api/payroll/emp501/export';

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
  paye4102: 54_000,
  uifEmployee: 177.12,
  uifEmployer: 177.12,
  sdl4142: 3_600,
};

describe('e@syFile: a non-cash benefit under its own income code', () => {
  it('writes 3801 beside 3601, cents dropped, after 3605 and before the lump sums and 4102', () => {
    const lines = buildEmployeeRecord({
      ...base, annualPayments3605: 10_000, fringeBenefits: [{ sourceCode: '3801', amount: 9_000.75 }],
      lumpSums: [{ sourceCode: '3901', directiveNumber: '9876543210', directiveIssuedDate: '20260505', amount: 30_000, paye: 3_000 }],
    });
    const at = (f: string) => lines.indexOf(f);
    expect(lines.filter(l => /^3[6-9]\d\d,/.test(l))).toEqual(['3601,360000', '3605,10000', '3801,9000', '3901,30000']);
    expect(at('3605,10000')).toBeLessThan(at('3801,9000'));
    expect(at('3801,9000')).toBeLessThan(at('3901,30000'));
    expect(at('3901,30000')).toBeLessThan(at('4102,54000.00'));
  });

  it('writes nothing under 3801 for no benefit, or one under R1 (a nil field is left out)', () => {
    expect(buildEmployeeRecord(base).some(l => l.startsWith('3801,'))).toBe(false);
    expect(buildEmployeeRecord({ ...base, fringeBenefits: [{ sourceCode: '3801', amount: 0.5 }] }).some(l => l.startsWith('3801,'))).toBe(false);
  });

  it('a benefit alone is an income code above zero (BRS 3(p))', () => {
    const lines = buildEmployeeRecord({ ...base, grossSalary3601: 0, paye4102: 100, fringeBenefits: [{ sourceCode: '3801', amount: 2_000 }] });
    expect(lines).toContain('3801,2000');
    expect(lines.some(l => l.startsWith('3601,'))).toBe(false);
  });

  it('counts toward the income a nil-tax certificate is judged on (4150 = 02 only under the threshold)', () => {
    const nilTax = { ...base, grossSalary3601: 90_000, paye4102: 0, taxThreshold: 99_000 };
    expect(buildEmployeeRecord(nilTax)).toContain('4150,02');
    expect(() => buildEmployeeRecord({ ...nilTax, fringeBenefits: [{ sourceCode: '3801', amount: 20_000 }] })).toThrow(/R110000.00.*above the tax threshold/);
  });
});

describe('EMP501 CSV: the benefit in its own column, after the existing ones', () => {
  it('keeps gross_income cash and appends fringe_3801', () => {
    const csv = buildEmp501Csv([{ first_name: 'Thandi', last_name: 'Molefe', tax_number: '0123456789', gross_income: 369_000, total_paye: 70_000, total_uif: 1_594.08, total_sdl: 3_780, fringe_3801: 9_000 }]);
    expect(csv.split('\n')).toEqual([
      'employee_name,irp5_number,gross_income,paye,uif,sdl,fringe_3801',
      'Thandi Molefe,0123456789,369000.00,70000.00,1594.08,3780.00,9000.00',
    ]);
  });
});
