/**
 * An independent contractor on the e@syFile export: income under code 3616, never 3601 (PAYE-GEN-01-G21 (2027) Rev 1 p. 26);
 * with no PAYE the certificate is an IT3(a) with 4150 = 03 (SARS BRS V25.3.0 p. 109, valid with 3616 per p. 62), over or under the
 * R99 000 threshold alike (as 3601 with no tax over the threshold, nilTaxReason would refuse the whole file).
 */
import { describe, expect, it } from 'vitest';
import { contractorAwareReason, splitContractorIncome } from '@/modules/accounting/services/payroll/easyFileContractor';
import { buildEmployeeRecord, type EmployeeInput } from '@/modules/accounting/services/payroll/easyFileExportService';
import { validateCertificateTaxFields } from '@/modules/accounting/services/payroll/irp5ValidationEngine';

describe('splitContractorIncome: decided per line, never from the status today; ALL contractor income is 3616', () => {
  const z = { contractorAnnual: 0, contractorDirective: 0, contractorNonCash: 0, annualAll: 0 };
  it('no contractor line: all of it is 3601 (directives added), the employee annual payments unchanged', () => {
    expect(splitContractorIncome({ ...z, annualAll: 4_000, totalGross: 60_000, contractorGross: 0, standaloneGross: 5_000 }))
      .toEqual({ salaryGross: 65_000, annualPayments: 4_000, income3616: 0 });
  });
  it('switched to contractor mid-year (6 employee months of 10 000, 6 contractor months of 12 000): 60 000 employee, 72 000 as 3616', () => {
    expect(splitContractorIncome({ ...z, totalGross: 132_000, contractorGross: 72_000, standaloneGross: 0 })).toEqual({ salaryGross: 60_000, annualPayments: 0, income3616: 72_000 });
  });
  it('switched back to employee mid-year (contractor first): the same split, whatever the status now', () => {
    expect(splitContractorIncome({ ...z, totalGross: 132_000, contractorGross: 60_000, standaloneGross: 0 })).toEqual({ salaryGross: 72_000, annualPayments: 0, income3616: 60_000 });
  });
  it('a contractor annual payment is 3616, not 3605: 30 000 of 100 000 in contractor lines, 10 000 more in employee lines', () => {
    const r = splitContractorIncome({ ...z, totalGross: 200_000, contractorGross: 100_000, contractorAnnual: 30_000, annualAll: 40_000, standaloneGross: 0 });
    expect(r).toEqual({ salaryGross: 100_000, annualPayments: 10_000, income3616: 100_000 });
    // 3601 + 3605 + 3616 is the year's total
    expect((r.salaryGross - r.annualPayments) + r.annualPayments + r.income3616).toBe(200_000);
  });
  it('contractor fees 100 000 plus a 50 000 directive in the same lines: 3616 is 100 000, the 50 000 stays for the lump-sum split (3901), 3601 is nil', () => {
    const r = splitContractorIncome({ ...z, totalGross: 150_000, contractorGross: 150_000, contractorDirective: 50_000, standaloneGross: 0 });
    expect(r.income3616).toBe(100_000);
    // splitCertificateIncome removes the 50 000 lump sum from this gross: 3601 = 50 000 - 50 000
    expect(r.salaryGross - 50_000).toBe(0);
  });
  it('the mixed year: employee 60 000, contractor 90 000 of which a 30 000 directive: 3616 60 000, 3601 60 000', () => {
    const r = splitContractorIncome({ ...z, totalGross: 150_000, contractorGross: 90_000, contractorDirective: 30_000, standaloneGross: 0 });
    expect([r.income3616, r.salaryGross - 30_000]).toEqual([60_000, 60_000]);
  });
  it('a directive reversal nets below nil (no lower floor): fees 100 000 and a -50 000 reversal give 3616 100 000, 3601 nil', () => {
    const r = splitContractorIncome({ ...z, totalGross: 50_000, contractorGross: 50_000, contractorDirective: -50_000, standaloneGross: 0 });
    expect(r.income3616).toBe(100_000);
    expect(r.salaryGross - (-50_000)).toBe(0); // splitCertificateIncome removes the -50 000 lump sum from this gross
  });
  it('paid on an employee line, reversed on a contractor line beside 100 000 of fees: 3616 100 000 and 100 000 left for 3601', () => {
    const r = splitContractorIncome({ ...z, totalGross: 200_000, contractorGross: 50_000, contractorDirective: -50_000, standaloneGross: 0 });
    expect([r.income3616, r.salaryGross - 0]).toEqual([100_000, 100_000]); // the lump sum nets to nil across the year
  });
  it('a contractor non-cash benefit is 3616, outside gross_pay', () => {
    expect(splitContractorIncome({ ...z, totalGross: 50_000, contractorGross: 50_000, contractorNonCash: 7_000, standaloneGross: 0 }).income3616).toBe(57_000);
  });
  it('an all-contractor year: 3601 is nil', () => {
    expect(splitContractorIncome({ ...z, totalGross: 90_000, contractorGross: 90_000, standaloneGross: 0 }).salaryGross).toBe(0);
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

  it('a contractor paid only what the payroll calls an annual payment: the amount is 3616, reason 03, valid', () => {
    const { income3616, annualPayments } = splitContractorIncome({ totalGross: 150_000, contractorGross: 150_000, contractorAnnual: 150_000, contractorDirective: 0, contractorNonCash: 0, annualAll: 150_000, standaloneGross: 0 });
    const lines = buildEmployeeRecord({ ...base, annualPayments3605: annualPayments, independentContractor3616: income3616 });
    expect(lines).toEqual(expect.arrayContaining(['3616,150000', '4150,03']));
    expect(lines.some(l => l.startsWith('3605,') || l.startsWith('3601,'))).toBe(false);
    expect(validateCertificateTaxFields(lines)).toEqual([]);
  });

  it('the same income as 3601 over the threshold refuses the file (why the contractor is not filed that way)', () => {
    expect(() => buildEmployeeRecord({ ...base, grossSalary3601: 150_000 })).toThrow(/no PAYE was deducted/);
  });
});

describe('the reason on a mixed certificate: 03 never hides an employee part over the threshold', () => {
  it('120 000 of employee income with nil PAYE beside 1 000 of contractor fees is refused', () => {
    expect(() => buildEmployeeRecord({ ...base, grossSalary3601: 120_000, independentContractor3616: 1_000 })).toThrow(/no PAYE was deducted/);
    expect(() => contractorAwareReason({ ...base, grossSalary3601: 120_000, independentContractor3616: 1_000 })).toThrow(/no PAYE was deducted/);
  });
  it('an employee part under the threshold beside contractor fees is reason 03', () => {
    const lines = buildEmployeeRecord({ ...base, grossSalary3601: 40_000, independentContractor3616: 150_000 });
    expect(lines).toEqual(expect.arrayContaining(['3601,40000', '3616,150000', '4150,03']));
    expect(validateCertificateTaxFields(lines)).toEqual([]);
  });
  it('a nil employee part is reason 03 at any contractor amount', () => {
    expect(contractorAwareReason({ ...base, independentContractor3616: 900_000 })).toBe('03');
  });
  it('no contractor income: the employee rule as before', () => {
    expect(contractorAwareReason({ ...base, grossSalary3601: 60_000 })).toBe('02');
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
