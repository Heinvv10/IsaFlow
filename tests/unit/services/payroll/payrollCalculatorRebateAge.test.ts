/**
 * P10: the secondary / tertiary rebate follows age on the LAST DAY of the tax
 * year (28/29 Feb), not at the 28th of the pay month. SARS grants it for the
 * whole year of assessment to an employee who reaches 65 / 75 by then.
 *
 * Expected values are hand-computed, taxYear 2027 (March 2026 - February 2027),
 * R40 000 a month = R480 000 a year: tax 110 037 less rebates, divided by 12.
 */
import { describe, it, expect } from 'vitest';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import type { PayrollEmployee, PayrollLineInput } from '@/modules/accounting/services/payroll/payrollTypes';

function line(dateOfBirth: Date, month: number, year: number) {
  const employee = {
    id: 'emp-1',
    dateOfBirth,
    startDate: new Date(2015, 0, 1),
    uifExcluded: true,
    medicalAidMainMember: false,
    medicalAidDependantsCount: 0,
  } as unknown as PayrollEmployee;
  const input: PayrollLineInput = {
    employee,
    components: [{
      component: {
        id: 'c1', name: 'Salary', sarsSourceCode: '3601', componentType: 'earning',
        isTaxable: true, isUifApplicable: false, isSdlApplicable: false,
      },
      amount: 40_000,
    }],
    period: { month, year },
    taxYear: 2027,
    annualPayrollEstimate: 'defer',
  };
  return calculatePayrollLine(input).paye.monthlyPaye;
}

describe('age rebate is decided at the end of the tax year', () => {
  it('turns 65 in January 2027: secondary rebate from March 2026', () => {
    const dob = new Date(1962, 0, 15);
    expect(line(dob, 3, 2026)).toBe(6_871);       // (110 037 - 17 820 - 9 765) / 12
    expect(line(dob, 10, 2026)).toBe(6_871);
    expect(line(dob, 1, 2027)).toBe(6_871);
  });

  it('turns 65 on 28 Feb 2027, the last day: still qualifies for the year', () => {
    expect(line(new Date(1962, 1, 28), 3, 2026)).toBe(6_871);
  });

  it('turns 65 on 1 Mar 2027, the first day of the next year: no secondary rebate', () => {
    expect(line(new Date(1962, 2, 1), 3, 2026)).toBe(7_684.75);   // (110 037 - 17 820) / 12
  });

  it('turns 75 in February 2027: tertiary rebate from March 2026', () => {
    expect(line(new Date(1952, 1, 20), 3, 2026)).toBe(6_600.25);  // (110 037 - 30 834) / 12
  });

  it('is 74 at year end: secondary only', () => {
    expect(line(new Date(1952, 2, 5), 3, 2026)).toBe(6_871);
  });

  it('under 65 at year end: primary rebate only', () => {
    expect(line(new Date(1990, 5, 1), 3, 2026)).toBe(7_684.75);
  });
});
