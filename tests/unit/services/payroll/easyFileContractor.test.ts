/**
 * An independent contractor on the e@syFile export (PAYE-GEN-01-G21 (2027) Rev 1 p. 26): income under code 3616, never 3601;
 * no PAYE withheld means no certificate (no 4150 reason exists for a contractor), whatever the income, over or under the
 * R99 000 threshold, so the file is never refused for them (nilTaxReason would refuse a whole file for R150 000 under 3601).
 */
import { describe, expect, it } from 'vitest';
import { contractorFiling } from '@/modules/accounting/services/payroll/easyFileContractor';
import { buildEmployeeRecord, type EmployeeInput } from '@/modules/accounting/services/payroll/easyFileExportService';
import { validateCertificateTaxFields } from '@/modules/accounting/services/payroll/irp5ValidationEngine';

const filing = (over: Partial<Parameters<typeof contractorFiling>[0]>) =>
  contractorFiling({ taxStatus: 'independent_contractor', who: 'A B', salaryIncome: 50_000, paye: 0, hasLumpSums: false, ...over });

describe('contractorFiling', () => {
  it('an employee or director is filed as before', () => {
    expect(filing({ taxStatus: 'employee' })).toEqual({ kind: 'employee' });
    expect(filing({ taxStatus: 'director' })).toEqual({ kind: 'employee' });
  });

  it.each([50_000, 98_999.99, 99_000, 150_000])('a contractor paid R%s with no PAYE is left off with a named warning', (salaryIncome) => {
    const f = filing({ salaryIncome });
    expect(f.kind).toBe('skip');
    expect(f.kind === 'skip' && f.warning).toContain('A B');
    expect(f.kind === 'skip' && f.warning).toContain('3616');
  });

  it('a contractor with PAYE withheld, or a directive, gets a certificate with the income as 3616', () => {
    expect(filing({ paye: 1_200, salaryIncome: 150_000 })).toEqual({ kind: 'certificate', income3616: 150_000 });
    expect(filing({ hasLumpSums: true })).toEqual({ kind: 'certificate', income3616: 50_000 });
  });
});

const base: EmployeeInput = {
  certificateNumber: '712345678920270200000000000001', yearOfAssessment: 2027, surname: 'Molefe', firstNames: 'Thandi', initials: 'T',
  idNumber: '9001015009087', taxNumber: '0123456789', employmentStartDate: '20250301', employmentEndDate: null, periodsInYoA: 12,
  grossSalary3601: 0, paye4102: 1_200, uifEmployee: 0, uifEmployer: 0, sdl4142: 0,
};

describe('the certificate record', () => {
  it.each([60_000, 150_000])('R%s under 3616 is an IRP5 with 3616 and no 3601 or 4150', (income) => {
    const lines = buildEmployeeRecord({ ...base, independentContractor3616: income, taxThreshold: 99_000 });
    expect(lines).toContain(`3616,${income}`);
    expect(lines.some(l => l.startsWith('3601,'))).toBe(false);
    expect(lines.some(l => l.startsWith('4150,'))).toBe(false);
    expect(lines).toContain('3015,"IRP5"');
    expect(validateCertificateTaxFields(lines)).toEqual([]);
  });

  it('3616 sits in income-code order, after 3605', () => {
    const lines = buildEmployeeRecord({ ...base, annualPayments3605: 5_000, independentContractor3616: 60_000 });
    expect(lines.findIndex(l => l.startsWith('3605,'))).toBeLessThan(lines.findIndex(l => l.startsWith('3616,')));
  });

  it('the same income as 3601 with no PAYE over the threshold refuses the file: the reason the contractor is left off', () => {
    expect(() => buildEmployeeRecord({ ...base, paye4102: 0, grossSalary3601: 150_000, taxThreshold: 99_000 })).toThrow(/no PAYE was deducted/);
  });
});
