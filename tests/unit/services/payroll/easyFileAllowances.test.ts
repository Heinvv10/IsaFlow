/**
 * The travel allowance and vehicle on the e@syFile certificate (wave 5 FB review, H1). SARS BRS PAYE Employer
 * Reconciliation V25.3.0: 3701 is its own income code (p. 47, 105), 4582 "The portion (80 or 20%) of the allowance and
 * benefit which is subject to PAYE" (p. 105; mandatory when 3701 + 3802 + 3816 is above zero and within 20-80% of it,
 * p. 54), 4474 the employer's medical contribution = 3810 (p. 103), 4497 totals the 40 / 44 / 45 codes.
 */
import { describe, expect, it } from 'vitest';
import { buildEmployeeRecord, type EmployeeInput } from '@/modules/accounting/services/payroll/easyFileExportService';
import { allowanceCertificateFields } from '@/modules/accounting/services/payroll/payrollAllowanceFiling';

const base: EmployeeInput = {
  certificateNumber: '712345678920270200000000000001', yearOfAssessment: 2027, surname: 'Molefe', firstNames: 'Thandi', initials: 'T',
  idNumber: '9001015009087', taxNumber: '0123456789', employmentStartDate: '20250301', employmentEndDate: null, periodsInYoA: 12,
  grossSalary3601: 360_000, paye4102: 54_000, uifEmployee: 177.12, uifEmployer: 177.12, sdl4142: 3_600,
};
const filing = (cash3701: number, vehicle3802: number, payeIncluded: number, legacyLines = 0) => ({ cash3701, vehicle3802, payeIncluded, legacyLines });

describe('allowanceCertificateFields', () => {
  it('R30 000 + R5 000 travel at 80%: 3701 5 000 and 4582 4 000', () => {
    expect(allowanceCertificateFields(filing(5000, 0, 4000), 'T')).toEqual({ cashAllowances: [{ sourceCode: '3701', amount: 5000 }], paye4582: 4000, warnings: [] });
  });
  it('a vehicle at 20% of 13 000 and a travel allowance at 80% of 5 000: 4582 is the sum of the shares', () => {
    expect(allowanceCertificateFields(filing(5000, 13000, 6600), 'T').paye4582).toBe(6600);
  });
  it('a vehicle alone carries 4582 and no 3701', () => {
    const r = allowanceCertificateFields(filing(0, 14000, 11200), 'T');
    expect(r.cashAllowances).toEqual([]);
    expect(r.paye4582).toBe(11200);
  });
  it('lines costed before the rate was stored (taxed whole) are clamped to 80% and said so', () => {
    const r = allowanceCertificateFields(filing(5000, 0, 5000, 3), 'Thandi');
    expect(r.paye4582).toBe(4000);
    expect(r.warnings[0]).toMatch(/Thandi.*4582.*20% to 80%.*3 line/);
  });
  it('an employee with neither has no 4582', () => {
    expect(allowanceCertificateFields(undefined, 'T')).toEqual({ cashAllowances: [], warnings: [] });
    expect(allowanceCertificateFields(filing(0, 0, 0), 'T').paye4582).toBeUndefined();
  });
});

describe('the record', () => {
  it('3601 30 000, 3701 5 000 and 4582 4 000: income codes in order, 4582 after 4150, 4497 counts it', () => {
    const lines = buildEmployeeRecord({ ...base, grossSalary3601: 30_000, cashAllowances: [{ sourceCode: '3701', amount: 5_000 }], paye4582: 4_000 });
    expect(lines.filter((l) => /^(3601|3701|4582|4497),/.test(l))).toEqual(['3601,30000', '3701,5000', '4497,4000', '4582,4000']);
    expect(lines.indexOf('3601,30000')).toBeLessThan(lines.indexOf('3701,5000'));
    expect(lines.indexOf('4150,02') === -1 ? 0 : lines.indexOf('4150,02')).toBeLessThan(lines.indexOf('4582,4000'));
  });
  it('writes 4474 equal to 3810 for an employer medical contribution', () => {
    const lines = buildEmployeeRecord({ ...base, fringeBenefits: [{ sourceCode: '3810', amount: 3_000 }] });
    expect(lines).toContain('3810,3000');
    expect(lines).toContain('4474,3000');
  });
  it('no 4582 and no 3701 when there is no allowance', () => {
    const lines = buildEmployeeRecord(base);
    expect(lines.some((l) => l.startsWith('4582,') || l.startsWith('3701,'))).toBe(false);
  });
  it('a certificate whose only income is a 3701 is an income code above zero', () => {
    expect(() => buildEmployeeRecord({ ...base, grossSalary3601: 0, paye4102: 100, cashAllowances: [{ sourceCode: '3701', amount: 2_000 }], paye4582: 1_600 })).not.toThrow();
  });
});
