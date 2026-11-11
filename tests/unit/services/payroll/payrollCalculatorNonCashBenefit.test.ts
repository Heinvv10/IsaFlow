/**
 * A non-cash fringe benefit (the low-interest loan benefit, SARS 3801, injected by
 * appendLoanComponents with `isNonCash`) on one line, figure by figure. The design note heads
 * payrollCalculator.ts; the SDL threshold over history is sdlLeviabilityService's.
 *
 *  - PAYE: remuneration (Fourth Schedule para 1, "remuneration" includes para (i) of "gross
 *    income", the Seventh Schedule cash equivalent), so taxed exactly as the same amount of cash.
 *  - UIF: the component's own is_uif_applicable flag decides, as for any earning
 *    (setup-components creates the 3801 with it off).
 *  - SDL: leviable (SDL Act s3(3): the para 1 remuneration).
 *  - ETI: NOT in "monthly remuneration": from 1 March 2022 its proviso disregards non-cash payments
 *    (ET; SARS Guide to the Employment Tax Incentive, Issue 5, §2.4.1 p. 18).
 *  - Cash: not in gross pay and not paid in net pay.
 */
import { describe, expect, it } from 'vitest';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import type { EmployeeComponent, PayrollComponent, PayrollEmployee, PayrollLineInput } from '@/modules/accounting/services/payroll/payrollTypes';

const employee = (over: Partial<PayrollEmployee> = {}): PayrollEmployee => ({
  id: 'emp-1', companyId: 'co-1', employeeNumber: 'E001', firstName: 'Test', lastName: 'Employee',
  idNumber: '9001015009086', taxNumber: '1234567890', employmentType: 'permanent', // a valid SA ID (Luhn): ETI Act s6(b)
  startDate: new Date('2020-01-01'), dateOfBirth: new Date('1980-01-01'), uifExcluded: false,
  medicalAidMainMember: false, medicalAidDependantsCount: 0, ...over,
});
const salary = (amount: number): EmployeeComponent => ({
  component: {
    id: 'salary', name: 'Basic Salary', sarsSourceCode: '3601', componentType: 'earning',
    isTaxable: true, isUifApplicable: true, isSdlApplicable: true,
  },
  amount,
});
// As setup-components creates it: taxable, not UIF-applicable, SDL-applicable.
const benefit = (amount: number, over: Partial<PayrollComponent> = {}): EmployeeComponent => ({
  component: {
    id: 'loan-fringe', name: 'Low-interest loan — fringe benefit', sarsSourceCode: '3801', componentType: 'earning',
    isTaxable: true, isUifApplicable: false, isSdlApplicable: true, ...over,
  },
  amount,
  isNonCash: true,
});
const line = (components: EmployeeComponent[], over: Partial<PayrollLineInput> = {}) => calculatePayrollLine({
  employee: employee(), components, period: { month: 6, year: 2025 }, taxYear: 2026,
  annualPayrollEstimate: 1_000_000, ...over,
});

describe('a non-cash 3801 benefit on a pay line [Fourth Schedule para 1; SDL Act s3(3)]', () => {
  const withBenefit = line([salary(10_000), benefit(1_000)]);
  const sameInCash = line([salary(11_000)]);

  it('is taxed as remuneration: PAYE equals that on the same amount paid in cash', () => {
    expect(withBenefit.taxableIncome).toBe(11_000);
    expect(withBenefit.periodicTaxable).toBe(11_000);
    expect(withBenefit.paye.monthlyPaye).toBeGreaterThan(0);
    expect(withBenefit.paye.monthlyPaye).toBe(sameInCash.paye.monthlyPaye);
  });

  it('is left out of UIF when its component is not UIF-applicable (the setup default)', () => {
    expect(withBenefit.uif.employeeContribution).toBe(100);
    expect(withBenefit.uif.employerContribution).toBe(100);
  });

  it('follows the component flag when it is UIF-applicable', () => {
    const flagged = line([salary(10_000), benefit(1_000, { isUifApplicable: true })]);
    expect(flagged.uif.employeeContribution).toBe(110);
  });

  it('is SDL-leviable', () => {
    expect(withBenefit.sdlLeviable).toBe(11_000);
    expect(withBenefit.sdl).toBe(110);
  });

  it('is not cash: gross pay leaves it out, remuneration keeps it, and net pay does not pay it', () => {
    expect(withBenefit.grossPay).toBe(10_000);
    expect(withBenefit.remuneration).toBe(11_000);
    expect(withBenefit.netPay).toBe(Math.round((10_000 - withBenefit.paye.monthlyPaye - 100) * 100) / 100);
  });

  it('records the item as non-cash on the breakdown, so later reads can tell it from cash', () => {
    expect(withBenefit.componentBreakdown).toContainEqual(expect.objectContaining({ componentId: 'loan-fringe', amount: 1_000, isNonCash: true }));
    expect(withBenefit.componentBreakdown.find((i) => i.componentId === 'salary')).not.toHaveProperty('isNonCash');
  });

  it('is left out of ETI monthly remuneration (R5 000 cash stays in the flat band: R1 500, not R1 125 on R6 000)', () => {
    const young = { employee: employee({ dateOfBirth: new Date('2001-01-01'), startDate: new Date('2025-01-01') }) };
    const eti = line([salary(5_000), benefit(1_000)], young).eti;
    expect(eti.isEligible).toBe(true);
    expect(eti.monthlyEti).toBe(1_500);
    expect(line([salary(5_000)], young).eti.monthlyEti).toBe(1_500);
  });
});

describe('a shortfall on a line with a non-cash benefit', () => {
  // R1 000 cash, R20 000 benefit: PAYE on R21 000 is more than the cash, with no other deduction.
  const short = line([salary(1_000), benefit(20_000)]);
  const warning = short.validationResults.find((w) => w.code === 'DEDUCTIONS_EXCEED_PAY');

  it('says the PAYE includes tax on the benefit, which is taxed but not paid', () => {
    expect(warning?.message).toMatch(/PAYE includes the tax on R.?20.?000\.00 of non-cash benefits/);
  });

  it('says nothing of a benefit when there is none', () => {
    const plain = line([salary(1_000), { ...salary(5_000), component: { ...salary(0).component, id: 'd', componentType: 'deduction', sarsSourceCode: '4018', isTaxable: false } }]);
    const w = plain.validationResults.find((x) => x.code === 'DEDUCTIONS_EXCEED_PAY');
    expect(w?.message).toBeDefined();
    expect(w?.message).not.toMatch(/non-cash/);
  });
});
