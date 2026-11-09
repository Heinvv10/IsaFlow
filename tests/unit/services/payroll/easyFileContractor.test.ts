/**
 * An independent contractor on the e@syFile export: income under code 3616, never 3601 (PAYE-GEN-01-G21 (2027) Rev 1 p. 26);
 * with no PAYE the certificate is an IT3(a) with 4150 = 03 (SARS BRS V25.3.0 p. 109, valid with 3616 per p. 62), over or under the
 * R99 000 threshold alike (as 3601 with no tax over the threshold, nilTaxReason would refuse the whole file).
 */
import { describe, expect, it } from 'vitest';
import { contractorIncome3616 } from '@/modules/accounting/services/payroll/easyFileContractor';
import { buildEmployeeRecord, type EmployeeInput } from '@/modules/accounting/services/payroll/easyFileExportService';
import { validateCertificateTaxFields } from '@/modules/accounting/services/payroll/irp5ValidationEngine';

describe('contractorIncome3616', () => {
  it('an employee or director is filed as before', () => {
    expect(contractorIncome3616({ taxStatus: 'employee', salaryIncome: 50_000 })).toBeNull();
    expect(contractorIncome3616({ taxStatus: 'director', salaryIncome: 50_000 })).toBeNull();
  });
  it('a contractor files his salary income under 3616', () => {
    expect(contractorIncome3616({ taxStatus: 'independent_contractor', salaryIncome: 150_000 })).toBe(150_000);
  });
});

const base: EmployeeInput = {
  certificateNumber: '712345678920270200000000000001', yearOfAssessment: 2027, surname: 'Molefe', firstNames: 'Thandi', initials: 'T',
  idNumber: '9001015009087', taxNumber: '0123456789', employmentStartDate: '20250301', employmentEndDate: null, periodsInYoA: 12,
  grossSalary3601: 0, paye4102: 0, uifEmployee: 0, uifEmployer: 0, sdl4142: 0, taxThreshold: 99_000,
};

describe('the certificate record, no PAYE', () => {
  it.each([50_000, 98_999, 99_000, 150_000, 900_000])('R%s: IT3(a), 3616, 4150 = 03, no 3601, valid', (income) => {
    const lines = buildEmployeeRecord({ ...base, independentContractor3616: income });
    expect(lines).toContain('3015,"IT3(a)"');
    expect(lines).toContain(`3616,${income}`);
    expect(lines).toContain('4150,03');
    expect(lines.some(l => l.startsWith('3601,'))).toBe(false);
    expect(validateCertificateTaxFields(lines)).toEqual([]);
  });

  it('the same income as 3601 over the threshold refuses the file (why the contractor is not filed that way)', () => {
    expect(() => buildEmployeeRecord({ ...base, grossSalary3601: 150_000 })).toThrow(/no PAYE was deducted/);
  });
});

describe('the certificate record, PAYE withheld', () => {
  it('an IRP5 with the income under 3616 and no 4150', () => {
    const lines = buildEmployeeRecord({ ...base, paye4102: 1_200, independentContractor3616: 150_000 });
    expect(lines).toContain('3015,"IRP5"');
    expect(lines).toContain('3616,150000');
    expect(lines.some(l => l.startsWith('4150,'))).toBe(false);
    expect(validateCertificateTaxFields(lines)).toEqual([]);
  });

  it('3616 sits in income-code order, after 3605', () => {
    const lines = buildEmployeeRecord({ ...base, paye4102: 100, annualPayments3605: 5_000, independentContractor3616: 60_000 });
    expect(lines.findIndex(l => l.startsWith('3605,'))).toBeLessThan(lines.findIndex(l => l.startsWith('3616,')));
  });
});
