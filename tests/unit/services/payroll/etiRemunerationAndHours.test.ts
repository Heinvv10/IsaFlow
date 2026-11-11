/**
 * ETI base and hours (wave 5 ET, review round 1; ported from the adversarial reviewer's repros).
 * Sources: ETI Act s1 "monthly remuneration" and its proviso, s4(1)(a), s4(4), s7(5); SARS Guide to the Employment Tax
 * Incentive, Issue 5: §2.4 pp. 15-18 (para 1 remuneration; travel allowance at 80%; a reimbursive allowance within the
 * rate is not remuneration), §2.4.1 p. 18 (non-cash disregarded), §4.1 p. 31 (unpaid leave), §5.3 fn 147 (overtime hours).
 */
import { describe, expect, it } from 'vitest';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import type { EmployeeComponent, PayrollComponent, PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';

const emp = (over: Partial<PayrollEmployee> = {}): PayrollEmployee => ({
  id: 'e', companyId: 'c', employeeNumber: 'E1', firstName: 'Young', lastName: 'Worker', employmentType: 'permanent',
  startDate: new Date(2026, 0, 1), dateOfBirth: new Date(2000, 0, 1), uifExcluded: false, medicalAidMainMember: false,
  medicalAidDependantsCount: 0, s18aReceiptHeld: false, taxStatus: 'employee', payBasis: 'monthly', hoursPerWeek: 40, ...over,
});
const comp = (id: string, code: string, amount: number, over: Partial<PayrollComponent> = {}, extra: Partial<EmployeeComponent> = {}): EmployeeComponent => ({
  component: { id, name: id, sarsSourceCode: code, componentType: 'earning', isTaxable: true, isUifApplicable: true, isSdlApplicable: true, ...over },
  amount, ...extra,
});
/** March 2026: the April 2025 table; NMW R30.23. */
const run = (e: PayrollEmployee, cs: EmployeeComponent[]) => calculatePayrollLine({
  employee: e, components: cs, period: { month: 3, year: 2026 }, taxYear: 2027, annualPayrollEstimate: 1_000_000,
});
const codes = (r: ReturnType<typeof run>) => r.validationResults.map((v) => v.code);

describe('the ETI base is para 1 remuneration paid in cash', () => {
  it('a non-taxable reimbursive travel allowance (3703) is not remuneration: R5 300 salary -> R1 500', () => {
    const r = run(emp(), [comp('sal', '3601', 5_300), comp('reimb', '3703', 2_200, { isTaxable: false, isUifApplicable: false, isSdlApplicable: false })]);
    expect(r.eti.monthlyEti).toBe(1_500);
  });
  it('a 3701 travel allowance counts at 80%: 5 300 + 1 600 = 6 900 -> R450', () => {
    expect(run(emp(), [comp('sal', '3601', 5_300), comp('travel', '3701', 2_000)]).eti.monthlyEti).toBe(450);
  });
  it('an item flagged non-cash on a non-38xx code is left out too', () => {
    expect(run(emp(), [comp('sal', '3601', 5_300), comp('kind', '3713', 1_000, {}, { isNonCash: true })]).eti.monthlyEti).toBe(1_500);
  });
});

describe('s7(5) hours include overtime hours paid; the minimum wage is tested on ordinary hours', () => {
  it('hourly: 120 ordinary h @ R31 + 20 OT h (R930) = 140 h, R4 650 grossed to R5 314.29 -> 1 500 x 140/160 = R1 312.50', () => {
    const r = run(emp({ payBasis: 'hourly', hourlyRate: 31, hoursPerWeek: null }), [
      comp('hours', '3601', 3_720, {}, { quantity: 120, quantityUnit: 'hour' }),
      comp('ot', '3607', 930),
    ]);
    expect(r.eti.monthlyEti).toBe(1_312.5);
  });
});

describe('R-B: a monthly starter with no hours a week is apportioned on 40 a week', () => {
  it('starts 23 March 2026 (7 of 22 weekdays: 55.15 h), R1 500 -> R1 500 x 55.15/160 = R517.03, and warns', () => {
    const r = run(emp({ startDate: new Date(2026, 2, 23), hoursPerWeek: null }), [comp('sal', '3601', 1_500)]);
    expect(r.eti.monthlyEti).toBe(517.03);
    expect(codes(r)).toContain('ETI_HOURS_UNKNOWN');
  });
  it('a full month with no hours a week keeps the unapportioned figure and warns', () => {
    const r = run(emp({ hoursPerWeek: null }), [comp('sal', '3601', 1_500)]);
    expect(r.eti.monthlyEti).toBe(900);
    expect(codes(r)).toContain('ETI_HOURS_UNKNOWN');
  });
});

describe('a minimum-wage nil is never silent', () => {
  it('unpaid leave cannot be seen (NAMED LIMIT): R3 230 for a 40-hour month is nil, and the warning says to check unpaid leave', () => {
    const r = run(emp(), [comp('sal', '3601', 3_230)]);
    expect(r.eti.monthlyEti).toBe(0);
    const w = r.validationResults.find((v) => v.code === 'ETI_MINIMUM_WAGE_FAILED');
    expect(w?.message).toMatch(/unpaid leave/);
  });
  it('basic pay on a code other than 3601: nil with a warning naming the code', () => {
    const r = run(emp(), [comp('sal', '3699', 6_000)]);
    expect(r.eti.monthlyEti).toBe(0);
    expect(r.validationResults.find((v) => v.code === 'ETI_MINIMUM_WAGE_FAILED')?.message).toMatch(/no basic pay on SARS code 3601/);
  });
});
