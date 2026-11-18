/**
 * DBF on the e@syFile certificate (#1571 adversarial H and L2). SARS BRS PAYE Employer Reconciliation V25.3.0 (Jun-26):
 * - p. 103: 4472 / 4473 "Employer's pension / provident fund contributions paid for the benefit of employee, excluding the
 *   value of code 4585 / 4586": what the employer PAID, not the para 12D(3) value X, which 3817 / 3825 and the deemed
 *   4001 / 4003 carry (p. 100-101).
 * - p. 105-106: 4585 / 4586, the employer's contributions for a member who retired from the fund, or for a deceased
 *   member's dependants or nominees, who qualify for the "no value" provision of para 12D(6).
 * - p. 54: "If code 4585 is greater than zero and code 4472 is equal to zero, then codes 3817/3867 and 4001 must be zero".
 * - p. 54: "If code 4472 is completed, then code 3817 and/or 3867 and code 4001 must be completed": with the year's X nil the
 *   payment is not certified (coordinator ruling on #1571; UNVERIFIED against SARS's validator).
 * - p. 57: 4497 totals every 40xx / 44xx / 45xx value.
 */
import { describe, expect, it } from 'vitest';
import { buildEmployeeRecord, type EmployeeInput } from '@/modules/accounting/services/payroll/easyFileExportService';
import { employerFundContributionFields, retiredMemberFundFields } from '@/modules/accounting/services/payroll/easyFileRetirementFields';

const base: EmployeeInput = {
  certificateNumber: '712345678920270200000000000001', yearOfAssessment: 2027, surname: 'Molefe', firstNames: 'Thandi', initials: 'T',
  idNumber: '9001015009087', taxNumber: '0123456789', employmentStartDate: '20250301', employmentEndDate: null, periodsInYoA: 12,
  grossSalary3601: 240_000, paye4102: 23_000, uifEmployee: 2_125.44, uifEmployer: 2_125.44, sdl4142: 2_400, taxThreshold: 99_000,
};
const value = (lines: string[], code: string): number | undefined => {
  const l = lines.find((x) => x.startsWith(`${code},`));
  return l === undefined ? undefined : Number(l.split(',')[1]);
};

describe('4472 / 4473 are what the employer paid, 3817 / 3825 the value X', () => {
  it('X 78 000 a year, paid 26 400: 3817 78 000, 4001 deemed 18 000 + 78 000, 4472 26 400, 4497 the total', () => {
    const lines = buildEmployeeRecord({ ...base, retirementFund: { pension4001: 18_000, provident4003: 0, annuity4006: 0, donations4030: 0 },
      fringeBenefits: [{ sourceCode: '3817', amount: 78_000, employerPaid: 26_400 }] });
    expect([value(lines, '3817'), value(lines, '4001'), value(lines, '4472'), value(lines, '4497')]).toEqual([78_000, 96_000, 26_400, 122_400]);
  });

  it('X nil for the year, paid 14 400: no 3817 and so no 4472 (p. 54); 4001 only what the employee paid', () => {
    expect(employerFundContributionFields([{ sourceCode: '3817', amount: 0, employerPaid: 14_400 }])).toEqual([]);
    const lines = buildEmployeeRecord({ ...base, retirementFund: { pension4001: 18_000, provident4003: 0, annuity4006: 0, donations4030: 0 },
      fringeBenefits: [{ sourceCode: '3817', amount: 0, employerPaid: 14_400 }] });
    expect([value(lines, '3817'), value(lines, '4472'), value(lines, '4001')]).toEqual([undefined, undefined, 18_000]);
  });

  it('a defined-contribution 3817 (no employerPaid) is unchanged: 4472 equals the benefit', () => {
    expect(employerFundContributionFields([{ sourceCode: '3817', amount: 9_000 }, { sourceCode: '3825', amount: 1_200 }])).toEqual(['4472,9000', '4473,1200']);
  });
});

describe('para 12D(6) members: 4585 / 4586, with 3817 / 4472 nil', () => {
  it('a retired pension member paid 24 000: 4585 24 000 with the 45xx codes (where 4582 goes), no 3817 or 4472, in 4497', () => {
    const lines = buildEmployeeRecord({ ...base, fringeBenefits: [{ sourceCode: '3817', amount: 0, employerPaid: 0, retiredMemberPaid: 24_000 }] });
    expect([value(lines, '3817'), value(lines, '4472'), value(lines, '4001'), value(lines, '4585')]).toEqual([undefined, undefined, undefined, 24_000]);
    expect(lines.findIndex((l) => l.startsWith('4585,'))).toBeGreaterThan(lines.findIndex((l) => l.startsWith('4142,')));
    expect(lines.findIndex((l) => l.startsWith('4585,'))).toBeLessThan(lines.findIndex((l) => l.startsWith('9999,')));
    expect(value(lines, '4497')).toBe(24_000);
  });

  it('a provident member is 4586; nothing without a value', () => {
    expect(retiredMemberFundFields([{ sourceCode: '3825', amount: 0, retiredMemberPaid: 6_000 }])).toEqual(['4586,6000']);
    expect(retiredMemberFundFields([{ sourceCode: '3817', amount: 5_000, employerPaid: 5_000 }])).toEqual([]);
  });
});
