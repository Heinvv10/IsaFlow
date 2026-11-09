/**
 * An independent contractor on the e@syFile export: income under code 3616, never 3601 (PAYE-GEN-01-G21 (2027) Rev 1 p. 26);
 * with no PAYE the certificate is an IT3(a) with 4150 = 03 (SARS BRS V25.3.0 p. 109, valid with 3616 per p. 62), over or under the
 * R99 000 threshold alike (as 3601 with no tax over the threshold, nilTaxReason would refuse the whole file).
 */
import { describe, expect, it } from 'vitest';
import { splitContractorIncome } from '@/modules/accounting/services/payroll/easyFileContractor';
import { buildEmployeeRecord, type EmployeeInput } from '@/modules/accounting/services/payroll/easyFileExportService';
import { validateCertificateTaxFields } from '@/modules/accounting/services/payroll/irp5ValidationEngine';

describe('splitContractorIncome: decided per line, never from the status today', () => {
  it('no contractor line: all of it is 3601 (directives added)', () => {
    expect(splitContractorIncome({ totalGross: 60_000, contractorGross: 0, contractorAnnual: 0, standaloneGross: 5_000 })).toEqual({ salaryGross: 65_000, income3616: 0 });
  });
  it('switched to contractor mid-year (6 employee months of 10 000, 6 contractor months of 12 000): 60 000 as 3601, 72 000 as 3616', () => {
    expect(splitContractorIncome({ totalGross: 132_000, contractorGross: 72_000, contractorAnnual: 0, standaloneGross: 0 })).toEqual({ salaryGross: 60_000, income3616: 72_000 });
  });
  it('switched back to employee mid-year (contractor first): the same split, whatever the status now', () => {
    expect(splitContractorIncome({ totalGross: 132_000, contractorGross: 60_000, contractorAnnual: 0, standaloneGross: 0 })).toEqual({ salaryGross: 72_000, income3616: 60_000 });
  });
  it('a contractor annual payment stays 3605: a 150 000 contractor line that is all 3605 is no 3616 and no 3601', () => {
    const { salaryGross, income3616 } = splitContractorIncome({ totalGross: 150_000, contractorGross: 150_000, contractorAnnual: 150_000, standaloneGross: 0 });
    expect([income3616, salaryGross - 150_000]).toEqual([0, 0]); // splitCertificateIncome then removes the 150 000 annual payment from the gross
  });
  it('3601 + 3605 + 3616 is the year\'s total with a contractor bonus', () => {
    const { salaryGross, income3616 } = splitContractorIncome({ totalGross: 200_000, contractorGross: 100_000, contractorAnnual: 30_000, standaloneGross: 0 });
    const annualAll = 40_000; // 30 000 in the contractor lines, 10 000 in the employee ones
    expect(salaryGross - annualAll + annualAll + income3616).toBe(200_000);
    expect(income3616).toBe(70_000);
  });
  it('an all-contractor year: 3601 is nil', () => {
    expect(splitContractorIncome({ totalGross: 90_000, contractorGross: 90_000, contractorAnnual: 0, standaloneGross: 0 }).salaryGross).toBe(0);
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

  it('a contractor paid only an annual payment (3616 nil) is still reason 03, never a refused file', () => {
    const lines = buildEmployeeRecord({ ...base, annualPayments3605: 150_000, hadContractorLines: true });
    expect(lines).toContain('4150,03');
    expect(lines).toContain('3605,150000');
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
