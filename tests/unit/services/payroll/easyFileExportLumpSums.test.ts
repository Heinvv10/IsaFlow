/**
 * Audit 2026-10-18 P3: e@syFile annual payments (3605) and lump sums paid under
 * a SARS directive (3901/4115 and the 3230–3233 directive group, BRS V25.2.0).
 */
import { describe, it, expect } from 'vitest';
import { buildEmployeeRecord, splitCertificateIncome, type EmployeeInput } from '@/modules/accounting/services/payroll/easyFileExportService';

const validEmployee: EmployeeInput = {
  certificateNumber: '71234567892026020000000000000001'.slice(0, 30), // 30 chars
  yearOfAssessment: 2026,
  surname: 'Molefe',
  firstNames: 'Thandi Mbali',
  initials: 'TM',
  idNumber: '9001015009087',
  taxNumber: '0123456789',
  employmentStartDate: '20250301',
  employmentEndDate: null,
  periodsInYoA: 12,
  grossSalary3601: 360000,
  paye4102: 54000,
  uifEmployee: 177.12,
  uifEmployer: 177.12,
  sdl4142: 3600,
};

// ─── Audit 2026-10-18 P3: annual payments and lump sums under a directive ────

describe('buildEmployeeRecord — 3605 and directive lump sums', () => {
  const withLumpSum: EmployeeInput = {
    ...validEmployee,
    grossSalary3601: 20000,
    annualPayments3605: 14800,
    paye4102: 2115,
    lumpSums: [{ sourceCode: '3901', directiveNumber: '9876543210', directiveIssuedDate: '20260505', amount: 30000.4, paye: 3000 }],
  };

  it('emits the directive group before the income codes, then 3601, 3605, 3901, 4102, 4115', () => {
    const lines = buildEmployeeRecord(withLumpSum);
    const at = (field: string) => lines.indexOf(field);
    for (const f of ['3230,"9876543210"', '3231,20260505', '3232,3901', '3233,30000', '3601,20000', '3605,14800',
      '3901,30000', '4102,2115.00', '4115,3000.00']) {
      expect(lines, f).toContain(f);
    }
    expect(at('3233,30000')).toBeLessThan(at('3601,20000'));
    expect(at('3601,20000')).toBeLessThan(at('3605,14800'));
    expect(at('3605,14800')).toBeLessThan(at('3901,30000'));
    expect(at('4102,2115.00')).toBeLessThan(at('4115,3000.00'));
  });

  it('a lump sum alone is a valid certificate (no 3601)', () => {
    const lines = buildEmployeeRecord({ ...withLumpSum, grossSalary3601: 0, annualPayments3605: 0 });
    expect(lines.some(l => l.startsWith('3601,'))).toBe(false);
    expect(lines).toContain('3901,30000');
  });

  it('no lump sums: no 4115 and no directive group', () => {
    const lines = buildEmployeeRecord(validEmployee);
    expect(lines.some(l => /^(4115|3230|3231|3232|3233),/.test(l))).toBe(false);
  });

  it.each([['ABC123'], [''], ['000000'], ['1234567890123456']])('refuses directive number %j, naming the employee', (n) => {
    expect(() => buildEmployeeRecord({ ...withLumpSum, lumpSums: [{ ...withLumpSum.lumpSums![0]!, directiveNumber: n }] }))
      .toThrow(new RegExp(`${validEmployee.surname}.*certificate ${validEmployee.certificateNumber}`));
  });
});

describe('splitCertificateIncome', () => {
  it('takes lump sums and 3605 out of 3601, and lump-sum PAYE out of 4102', () => {
    expect(splitCertificateIncome({ gross: 60_000, paye: 7_307, annualPayments: 10_000, lumpSums: [{ sourceCode: '3901', amount: 30_000, paye: 3_000 }] }))
      .toEqual({ grossSalary3601: 20_000, annualPayments3605: 10_000, paye4102: 4_307 });
  });

  it('a year whose 3605 nets negative leaves it in 3601 instead of inflating 3601', () => {
    expect(splitCertificateIncome({ gross: 235_000, paye: 20_000, annualPayments: -5_000, lumpSums: [] }))
      .toEqual({ grossSalary3601: 235_000, annualPayments3605: 0, paye4102: 20_000 });
  });
});
