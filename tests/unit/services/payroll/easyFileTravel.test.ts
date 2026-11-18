/**
 * Reimbursive travel on the e@syFile certificate (wave 6 RI). SARS BRS PAYE Employer Reconciliation V25.3.0 (Jun-26;
 * V23.0.0 the same): 3702 is the part within the prescribed rate a km and 3703 the full reimbursement when at or below it
 * with no other travel compensation (p. 86); 3722 the excess above it (p. 90). On one certificate (p. 50): 3703 never beside
 * 3701, 3702 or 3722, its value then "included in the value of code 3702"; 3722 above nil needs 3702 above nil. 3696, the
 * non-taxable income total, is mandatory with 3703 (p. 51). Field-level: the record's own lines, as the file carries them.
 */
import { describe, expect, it } from 'vitest';
import { buildEmployeeRecord, UsageError, type EmployeeInput } from '@/modules/accounting/services/payroll/easyFileExportService';
import { allowanceCertificateFields, type AllowanceFiling } from '@/modules/accounting/services/payroll/payrollAllowanceFiling';

const base: EmployeeInput = {
  certificateNumber: '712345678920270200000000000001', yearOfAssessment: 2027, surname: 'Molefe', firstNames: 'Thandi', initials: 'T',
  idNumber: '9001015009087', taxNumber: '0123456789', employmentStartDate: '20250301', employmentEndDate: null, periodsInYoA: 12,
  grossSalary3601: 360_000, paye4102: 54_000, uifEmployee: 177.12, uifEmployer: 177.12, sdl4142: 3_600,
};
const filing = (t: Partial<AllowanceFiling>): AllowanceFiling => ({
  cash3701: 0, taxableCash3701: 0, vehicle3802: 0, payeIncluded: 0, legacyLines: 0, travel3702: 0, travel3703: 0, travel3722: 0, ...t,
});
const travelLines = (lines: string[]) => lines.filter((l) => /^(3601|3696|370[123]|3722),/.test(l));
const record = (f: AllowanceFiling, gross3601: number) => {
  const { cashAllowances } = allowanceCertificateFields(f, 'Thandi');
  return buildEmployeeRecord({ ...base, grossSalary3601: gross3601 - cashAllowances.reduce((t, a) => t + a.amount, 0), cashAllowances });
};

describe('reimbursive travel on the certificate', () => {
  it('1 000 km at R6 (prescribed R4.95): 3702 4950 and 3722 1050, out of 3601, no 3703 or 3696', () => {
    expect(travelLines(record(filing({ travel3702: 4950, travel3722: 1050 }), 366_000))).toEqual(['3601,360000', '3702,4950', '3722,1050']);
  });

  it('within the rate all year, nothing else paid: 3703 4000 with 3696 4000', () => {
    expect(travelLines(record(filing({ travel3703: 4000 }), 364_000))).toEqual(['3601,360000', '3703,4000', '3696,4000']);
  });

  it('a 3703 month and a 3702/3722 month in one year: the 3703 folds into 3702 (p. 50)', () => {
    expect(travelLines(record(filing({ travel3703: 4000, travel3702: 4950, travel3722: 1050 }), 370_000)))
      .toEqual(['3601,360000', '3702,8950', '3722,1050']);
  });

  it('a 3703 beside a 3701 travel allowance is certified as 3702', () => {
    const f = allowanceCertificateFields(filing({ cash3701: 3000, taxableCash3701: 3000, payeIncluded: 2400, travel3703: 4000 }), 'T');
    expect(f.cashAllowances).toEqual([{ sourceCode: '3701', amount: 3000 }, { sourceCode: '3702', amount: 4000 }]);
  });

  it('cents stay in 3601: 4 000.60 within the rate is certified as 4000', () => {
    expect(allowanceCertificateFields(filing({ travel3703: 4000.6 }), 'T').cashAllowances).toEqual([{ sourceCode: '3703', amount: 4000 }]);
  });
});

describe('the record refuses what SARS rejects (p. 50, 51)', () => {
  const build = (cashAllowances: EmployeeInput['cashAllowances']) => () => buildEmployeeRecord({ ...base, cashAllowances });
  it('3703 beside 3702', () => {
    expect(build([{ sourceCode: '3702', amount: 100 }, { sourceCode: '3703', amount: 100 }])).toThrow(/3703 must not be on a certificate with 3702/);
  });
  it('3722 with no 3702', () => {
    expect(build([{ sourceCode: '3722', amount: 100 }])).toThrow(UsageError);
    expect(build([{ sourceCode: '3722', amount: 100 }])).toThrow(/3722.*needs code 3702/);
  });
});
