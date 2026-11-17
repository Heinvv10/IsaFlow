/**
 * Wave 6 OC: an off-cycle line after its month's regular line (payrollOffCycleMonth.ts).
 *  - UIF: UIC Act 4 of 2002 s6(1)-(2): 1% of the remuneration paid during the month, not on remuneration above the
 *    ceiling during any month, so the month's runs together stop at 1% of the ceiling (spec F12: a monthly employee's
 *    off-cycle runs only).
 *  - ETI: ETI Act 26 of 2013 s7: a monthly amount on the monthly remuneration; the month is recomputed on everything it
 *    paid and the off-cycle line carries the difference, NEGATIVE when a bonus pushes the month into the taper.
 *  - PAYE: PAYE-GEN-01-G21 (2027) pp. 32-33: a bonus is an annual payment, tax(AE + A) - tax(AE), on the month's AE (the
 *    regular line in the year to date, spec F2); n is unchanged.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));

import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import { capUifToMonth, monthUifCap, NO_EARLIER_LINES, type MonthEarlierLines } from '@/modules/accounting/services/payroll/payrollOffCycleMonth';
import { getTaxYearConfig } from '@/modules/accounting/services/payroll/taxTables';
import type { EmployeeComponent, PayeYearToDate, PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';
import { expectRecomputes } from './payrollExplainRecompute.helpers';

const employee = (over: Partial<PayrollEmployee> = {}): PayrollEmployee => ({
  id: 'e1', companyId: 'co', employeeNumber: 'E1', firstName: 'Young', lastName: 'Worker', employmentType: 'permanent',
  startDate: new Date(2026, 0, 1), dateOfBirth: new Date(2004, 5, 1), idNumber: '0406015009086', uifExcluded: false, medicalAidMainMember: false,
  medicalAidDependantsCount: 0, s18aReceiptHeld: false, taxStatus: 'employee', payBasis: 'monthly', hoursPerWeek: 40, ...over,
});
const earning = (id: string, code: string, amount: number): EmployeeComponent => ({
  component: { id, name: code, sarsSourceCode: code, componentType: 'earning', isTaxable: true, isUifApplicable: true, isSdlApplicable: true }, amount,
});
const period = { month: 3, year: 2026 };
const regularLine = (salary: number, e = employee()) => calculatePayrollLine({
  employee: e, components: [earning('basic', '3601', salary)], period, taxYear: 2027, annualPayrollEstimate: 1_000_000,
});
/** The month's earlier lines as the reader gives them: the regular line's stored figures and its earnings. */
const earlierFrom = (r: ReturnType<typeof regularLine>, salary: number): MonthEarlierLines => ({
  uifEmployee: r.uif.employeeContribution, uifEmployer: r.uif.employerContribution, eti: r.eti.monthlyEti,
  etiComponents: [earning('basic', '3601', salary)],
});
const bonusLine = (bonus: number, earlier: MonthEarlierLines, ytd?: PayeYearToDate, e = employee()) => calculatePayrollLine({
  employee: e, components: [earning('bonus', '3605', bonus)], period, taxYear: 2027, annualPayrollEstimate: 1_000_000,
  monthEarlier: earlier, ...(ytd ? { ytd } : {}),
});

describe('UIF across the month (UIC Act s6(2))', () => {
  const cap = monthUifCap(2027);
  it('the cap is 1% of the monthly ceiling', () => {
    expect(cap).toBe(Math.round(getTaxYearConfig(2027).uifCeiling) / 100);
  });
  it('a regular line at the ceiling leaves the bonus no UIF', () => {
    const regular = regularLine(30_000);
    expect(regular.uif.employeeContribution).toBe(cap);
    const bonus = bonusLine(10_000, earlierFrom(regular, 30_000));
    expect(bonus.uif).toMatchObject({ employeeContribution: 0, employerContribution: 0, isCapped: true });
    expect(bonus.netPay).toBeCloseTo(10_000 - bonus.paye.monthlyPaye, 2);
  });
  it('a regular line under the ceiling: the bonus pays the room left, not its own 1%', () => {
    const regular = regularLine(12_000);
    const bonus = bonusLine(10_000, earlierFrom(regular, 12_000));
    expect(bonus.uif.employeeContribution).toBe(Math.round((cap - 120) * 100) / 100);
    expect(bonus.uif.employerContribution).toBe(bonus.uif.employeeContribution);
    expect(regular.uif.employeeContribution + bonus.uif.employeeContribution).toBeCloseTo(cap, 2);
    expectRecomputes(bonus);
  });
  it('a small bonus well under the room pays its own 1%', () => {
    const bonus = bonusLine(1_000, earlierFrom(regularLine(5_000), 5_000));
    expect(bonus.uif.employeeContribution).toBe(10);
    expect(bonus.uif.isCapped).toBe(false);
  });
  it('without earlier lines nothing is capped beyond the ceiling itself', () => {
    expect(capUifToMonth({ employeeContribution: 50, employerContribution: 50, isCapped: false }, NO_EARLIER_LINES, 2027))
      .toMatchObject({ employeeContribution: 50, employerContribution: 50, isCapped: false });
  });
  it('an earlier over-contribution never makes this line negative', () => {
    expect(capUifToMonth({ employeeContribution: 50, employerContribution: 50, isCapped: false },
      { ...NO_EARLIER_LINES, uifEmployee: cap + 5, uifEmployer: cap + 5 }, 2027).employeeContribution).toBe(0);
  });
});

describe('ETI across the month (ETI Act s7)', () => {
  it('a bonus that pushes the month into the taper reverses part of the regular claim: a negative line', () => {
    const regular = regularLine(5_300);
    expect(regular.eti.monthlyEti).toBe(1_500);
    const bonus = bonusLine(1_000, earlierFrom(regular, 5_300));
    // The month: R6 300 in the year-one taper, 1 500 - 0.75 x (6 300 - 5 500) = 900 (the same table the regular line read).
    const month = regularLine(6_300).eti.monthlyEti;
    expect(month).toBeLessThan(1_500);
    expect(bonus.eti.monthlyEti).toBe(Math.round((month - 1_500) * 100) / 100);
    expect(bonus.eti.monthlyEti).toBeLessThan(0);
    expectRecomputes(bonus);
  });
  it('the month is judged on the earlier earnings too: the regular salary carries the hours and the wage', () => {
    // Alone, a bonus pays no 3601 basic, so its wage fails the minimum-wage test and claims nothing (ETI Act s4(1)(a)).
    const alone = calculatePayrollLine({ employee: employee(), components: [earning('bonus', '3605', 500)], period, taxYear: 2027, annualPayrollEstimate: 1_000_000 });
    expect(alone.eti.monthlyEti).toBe(0);
    // On the month, the R5 300 salary's 3601 carries the wage and the hours: the month claims, the flat band's R1 500.
    const regular = regularLine(5_300);
    const bonus = bonusLine(100, earlierFrom(regular, 5_300));
    expect(bonus.explanations.eti.steps.find((st) => st.key === 'eti.month.total')?.amount).toBe(1_500);
    expect(bonus.eti.monthlyEti).toBe(0);
    expectRecomputes(bonus);
  });
});

describe('PAYE on the month\'s AE (G21 2027 pp. 32-33; spec F2)', () => {
  it('the bonus is taxed as an annual payment on top of the regular line, and n stays 1', () => {
    const regular = regularLine(30_000);
    const ytd: PayeYearToDate = {
      periods: 1, retirementCapPeriods: 1, periodicTaxable: 30_000, annualPayments: 0, tablePaye: regular.paye.monthlyPaye,
      medicalCredit: regular.medicalCredit, additionalMedicalCredit: 0, medicalSchemeFees: 0,
      sdlApplicable: 30_000, sdlLeviable: 30_000, sdlRetirementDeduction: 0,
    };
    const bonus = bonusLine(20_000, earlierFrom(regular, 30_000), ytd);
    expect(bonus.payeSplit.regular).toBe(0);
    expect(bonus.paye.monthlyPaye).toBe(bonus.payeSplit.annualPayment);
    const trace = bonus.explanations.paye.steps.find((s) => s.key === 'paye.periods');
    expect(trace?.amount ?? 1).toBe(1);
    // tax(AE + A) - tax(AE), AE = 30 000 x 12 = 360 000: R360 000 to R380 000 lies in the 2027 26% bracket (R245 101 -
    // R383 100), so the bonus's PAYE is 26% of it. Had the bonus run counted as a period, AE would be 50 000 x 12 / 2.
    expect(bonus.paye.monthlyPaye).toBe(5_200);
  });
});
