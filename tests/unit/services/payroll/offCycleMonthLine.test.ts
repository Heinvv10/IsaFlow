/**
 * Wave 6 OC: an off-cycle line after its month's regular line (payrollOffCycleMonth.ts).
 *  - UIF: UIC Act 4 of 2002 s6(1)-(2): 1% of the remuneration paid during the month, not on remuneration above the
 *    ceiling during any month: the line levies only the room the month's earlier REMUNERATION left under the ceiling
 *    (coordinator ruling 2026-11-16 06:40), so the month's runs together stop at 1% of the ceiling.
 *  - ETI: ETI Act 26 of 2013 s7: a monthly amount on the monthly remuneration; the month is recomputed on everything it
 *    paid and the off-cycle line carries the difference, NEGATIVE when a bonus pushes the month into the taper.
 *  - PAYE: PAYE-GEN-01-G21 (2027) pp. 32-33: a bonus is an annual payment, tax(AE + A) - tax(AE), on the month's AE (the
 *    regular line in the year to date, spec F2); n is unchanged.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => []) }));

import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import { NO_EARLIER_LINES, type MonthEarlierLines } from '@/modules/accounting/services/payroll/payrollOffCycleMonth';
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
  uifRemuneration: salary, eti: r.eti.monthlyEti,
  etiComponents: [earning('basic', '3601', salary)],
});
const bonusLine = (bonus: number, earlier: MonthEarlierLines, ytd?: PayeYearToDate, e = employee()) => calculatePayrollLine({
  employee: e, components: [earning('bonus', '3605', bonus)], period, taxYear: 2027, annualPayrollEstimate: 1_000_000,
  monthEarlier: earlier, ...(ytd ? { ytd } : {}),
});

describe('UIF across the month (UIC Act s6(2))', () => {
  const cap = Math.round(getTaxYearConfig(2027).uifCeiling) / 100;
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
    expect(bonusLine(5_000, NO_EARLIER_LINES).uif).toMatchObject({ employeeContribution: 50, employerContribution: 50, isCapped: false });
  });
  it('earlier remuneration far above the ceiling never makes this line negative', () => {
    const bonus = bonusLine(5_000, { ...NO_EARLIER_LINES, uifRemuneration: 90_000 });
    expect(bonus.uif).toMatchObject({ employeeContribution: 0, employerContribution: 0, isCapped: true });
    expectRecomputes(bonus);
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

describe('a weekly line before its month\'s last run (no off-cycle): the ETI explanation is the stored line\'s', () => {
  it('explains nil ETI with the pending reason, not the resolved month\'s figure', () => {
    const line = calculatePayrollLine({
      employee: employee(), components: [earning('basic', '3601', 1_500)],
      period: { month: 6, year: 2026 }, taxYear: 2027, annualPayrollEstimate: 1_000_000,
      cadence: { frequency: 'weekly', periodStart: '2026-06-01', periodEnd: '2026-06-07', uifMonthToDate: 0, etiMonthToDate: null },
    });
    expect(line.eti.monthlyEti).toBe(0);
    expect(line.eti.ineligibilityReason).toMatch(/^ETI is monthly/);
    const explained = line.explanations.eti;
    expect(explained.result).toBe(0);
    expect(JSON.stringify(explained.steps)).toContain('ETI is monthly');
  });
});

// Wave 6 OC x PSP (master's PSP, merged at OC's queue turn): an off-cycle bonus paid to a personal service provider is
// treated, not refused. The PSP flat rate applies to the payment (pspPayeBase counts the annual payment), with no UIF
// and no ETI, whatever the month's earlier lines say.
describe('an off-cycle bonus for a personal service provider', () => {
  it('pays the PSP flat rate on the bonus (27% company, 45% trust), no UIF, no ETI', () => {
    for (const [entity, rate] of [['company', 0.27], ['trust', 0.45]] as const) {
      const psp = employee({ taxStatus: 'personal_service_provider', pspEntityType: entity } as Partial<PayrollEmployee>);
      const line = bonusLine(10_000, { uifRemuneration: 20_000, eti: 0, etiComponents: [earning('basic', '3601', 20_000)] }, undefined, psp);
      expect(line.paye.monthlyPaye).toBeCloseTo(10_000 * rate, 2);
      expect(line.uif.employeeContribution).toBe(0);
      expect(line.eti.monthlyEti).toBe(0);
    }
  });
});
