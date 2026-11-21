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
import { NO_EARLIER_LINES, OffCycleEtiBasisError, type MonthEarlierLines } from '@/modules/accounting/services/payroll/payrollOffCycleMonth';
import { earningsOfBreakdown } from '@/modules/accounting/services/payroll/payrollOffCycleMonthRead';
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

  it('reverses no earlier ETI claim (review #1679 merge L1): the month\'s earlier R750 stands with its run, the PSP line has nil', () => {
    const psp = employee({ taxStatus: 'personal_service_provider', pspEntityType: 'company' } as Partial<PayrollEmployee>);
    const line = bonusLine(10_000, { uifRemuneration: 5_300, eti: 750, etiComponents: [earning('basic', '3601', 5_300)] }, undefined, psp);
    expect(line.eti.monthlyEti).toBe(0);
    expect(line.eti.ineligibilityReason).toMatch(/personal service provider/i);
    expectRecomputes(line);
  });
});

// Review #1679 codex 1 and 2: UIF is the month's liability rounded once, less what the earlier lines BOOKED (stored).
describe('UIF booked across the month (review #1679)', () => {
  it('an imported regular line with no breakdown that withheld R177.12 leaves the bonus no UIF', () => {
    const line = bonusLine(10_000, { uifRemuneration: 0, eti: 0, etiComponents: [], uifEmployee: 177.12, uifEmployer: 177.12 });
    expect(line.uif).toMatchObject({ employeeContribution: 0, employerContribution: 0 });
    expectRecomputes(line);
  });
  it('an imported R5 000 regular line with no breakdown that withheld R50: a R5 000 bonus owes R50 each side', () => {
    const line = bonusLine(5_000, { uifRemuneration: 0, eti: 0, etiComponents: [], uifEmployee: 50, uifEmployer: 50 });
    expect(line.uif).toMatchObject({ employeeContribution: 50, employerContribution: 50, isCapped: false });
    expectRecomputes(line);
  });
  it('each side on its own booked figure: R50 employee, R40 employer booked, then a R5 000 bonus', () => {
    const line = bonusLine(5_000, { uifRemuneration: 0, eti: 0, etiComponents: [], uifEmployee: 50, uifEmployer: 40 });
    expect(line.uif).toMatchObject({ employeeContribution: 50, employerContribution: 50 });
    const big = bonusLine(15_000, { uifRemuneration: 0, eti: 0, etiComponents: [], uifEmployee: 50, uifEmployer: 40 });
    // Employee: 1% of min(5 000 + 15 000, 17 712) = 177.12 − 50; employer: 1% of min(4 000 + 15 000, 17 712) − 40.
    expect(big.uif).toMatchObject({ employeeContribution: 127.12, employerContribution: 137.12, isCapped: true });
    expectRecomputes(big);
  });
  it('booked within what the rebuilt pay explains is not pay: R10 000.50 rebuilt, R100.01 booked, a R0.50 bonus owes nil (fix check L1)', () => {
    const line = bonusLine(0.5, { uifRemuneration: 10_000.5, eti: 0, etiComponents: [earning('basic', '3601', 10_000.5)],
      uifEmployee: 100.01, uifEmployer: 100.01 });
    expect(line.uif).toMatchObject({ employeeContribution: 0, employerContribution: 0 });
    expectRecomputes(line);
  });
  it('the sides diverge on the ceiling: R50 / R40 booked, then R13 000: the employee side is capped, the employer side is not (fix check L3)', () => {
    const line = bonusLine(13_000, { uifRemuneration: 0, eti: 0, etiComponents: [], uifEmployee: 50, uifEmployer: 40 });
    // Employee: 5 000 + 13 000 > 17 712, 177.12 − 50; employer: 4 000 + 13 000 = 17 000, 170 − 40.
    expect(line.uif).toMatchObject({ employeeContribution: 127.12, employerContribution: 130, isCapped: true });
    const steps = Object.fromEntries(line.explanations.uif.steps.map((st) => [st.key, st.amount]));
    expect([steps['uif.cappedEmployee'], steps['uif.cappedEmployer']]).toEqual([1, 0]);
    expect([steps['uif.leviableEmployee'], steps['uif.leviableEmployer']]).toEqual([12_712, 13_000]);
    expectRecomputes(line);
  });
  it('R10 001.50 then a R7 710.50 bonus: the month levies exactly R177.12 each side (R100.02 + R77.10, not R77.11)', () => {
    const regular = regularLine(10_001.5);
    expect(regular.uif.employeeContribution).toBe(100.02);
    const line = bonusLine(7_710.5, { uifRemuneration: 10_001.5, eti: 0, etiComponents: [earning('basic', '3601', 10_001.5)],
      uifEmployee: 100.02, uifEmployer: 100.02 });
    expect(line.uif).toMatchObject({ employeeContribution: 77.1, employerContribution: 77.1 });
    expect(Math.round((100.02 + line.uif.employeeContribution) * 100) / 100).toBe(177.12);
    expectRecomputes(line);
  });
});


describe('a monthly-paid hourly employee\'s bonus (review of 99db78312)', () => {
  const hourly = employee({ payBasis: 'hourly', hourlyRate: 33.13, hoursPerDay: 8 });
  const worked: EmployeeComponent = { ...earning('basic', '3601', 5_300.8), quantity: 160, quantityUnit: 'hour' };
  it('the bonus line is not judged on hours: its month\'s hours are on the regular line', () => {
    const regular = calculatePayrollLine({ employee: hourly, components: [worked], period, taxYear: 2027, annualPayrollEstimate: 1_000_000 });
    expect(regular.validationResults.map((v) => v.code)).not.toContain('HOURS_MISSING');
    const bonus = bonusLine(1_000, { uifRemuneration: 5_300.8, eti: regular.eti.monthlyEti, etiComponents: [worked] }, undefined, hourly);
    expect(bonus.validationResults.filter((v) => v.code.startsWith('HOURS_'))).toEqual([]);
  });
  it('a regular line still asks for the hours', () => {
    const regular = calculatePayrollLine({ employee: hourly, components: [], period, taxYear: 2027, annualPayrollEstimate: 1_000_000 });
    expect(regular.validationResults.map((v) => v.code)).toContain('HOURS_MISSING');
  });
});

describe('an earlier line whose earnings cannot be rebuilt (review of 99db78312)', () => {
  const imported = (eti: number): MonthEarlierLines => ({ uifRemuneration: 0, uifEmployee: 53, uifEmployer: 53, eti, etiComponents: [], unrebuiltPay: 5_300 });
  it('an imported regular line that claimed ETI refuses the bonus: the month\'s ETI cannot be costed on the bonus alone', () => {
    expect(() => bonusLine(1_000, imported(1_500))).toThrow(OffCycleEtiBasisError);
  });
  it('one that claimed none still refuses where the bonus alone would claim', () => {
    const regular = regularLine(5_300);
    expect(regular.eti.monthlyEti).toBeGreaterThan(0);
    expect(() => calculatePayrollLine({
      employee: employee(), components: [earning('basic', '3601', 5_300)], period, taxYear: 2027, annualPayrollEstimate: 1_000_000,
      monthEarlier: imported(0),
    })).toThrow(OffCycleEtiBasisError);
  });
  it('where ETI is not at stake (no claim and none on the month), the bonus is costed', () => {
    const older = employee({ dateOfBirth: new Date(1970, 0, 1), idNumber: '7001015009087' });
    const bonus = bonusLine(1_000, imported(0), undefined, older);
    expect(bonus.eti.monthlyEti).toBe(0);
  });
  it('earlier lines that rebuild are costed as before', () => {
    const regular = regularLine(5_300);
    expect(() => bonusLine(1_000, { ...earlierFrom(regular, 5_300), unrebuiltPay: 0 })).not.toThrow();
  });
});

// Gate ruling 2 on 7630d9379f: the bonus line is classified (G21 p. 28) on the month's time-worked earnings, the
// regular line's included, as the regular line was: a bonus alone has none, so the recorded day rate would decide.
describe('PAYE classification of an off-cycle bonus (review #1679 gate ruling 2)', () => {
  // 20 hours a week, 8 a day, R300 a day recorded; overtime took the month's earnings to R450 a day (R4 875 over
  // 20 / 8 × 52 / 12 days): non-standard on the regular line (at least the 2027 threshold a day).
  const partTime = employee({ hoursPerWeek: 20, hoursPerDay: 8, dailyRate: 300, payBasis: 'daily' });
  const regular = regularLine(4_875, partTime);
  const treatmentOf = (l: ReturnType<typeof regularLine>) => l.explanations.paye.steps.find((s) => s.key === 'paye.treatment')?.label;
  it('the regular line is non-standard (flat rate), and the bonus beside it is too', () => {
    expect(treatmentOf(regular)).toMatch(/Non-standard employment/);
    const bonus = bonusLine(10_000, earlierFrom(regular, 4_875), undefined, partTime);
    expect(treatmentOf(bonus)).toMatch(/Non-standard employment/);
  });
});

describe('the employment class across the month (G21 p. 28 day pay; review #1679 Codex of 7630d9379)', () => {
  // 14 hours a week in days of 6 at R300 a day: deemed standard (tables) on the rate alone. 3 033 + 1 517 = R4 550 for
  // the month's 10.11 scheduled days is R450 a day, over R394: the regular line is non-standard (flat 25%).
  const partTime = employee({ payBasis: 'daily', hoursPerWeek: 14, hoursPerDay: 6, dailyRate: 300 });
  const month = [earning('basic', '3601', 3_033), earning('overtime', '3607', 1_517)];
  const earlier: MonthEarlierLines = { uifRemuneration: 4_550, eti: 0, etiComponents: month };
  it('the bonus is classified on the regular line\'s basic pay and overtime, as the regular line was', () => {
    const regular = calculatePayrollLine({ employee: partTime, components: month, period, taxYear: 2027, annualPayrollEstimate: 1_000_000 });
    expect(regular.paye.monthlyPaye).toBeCloseTo(4_550 * 0.25, 2);
    const bonus = bonusLine(10_000, earlier, undefined, partTime);
    expect(bonus.paye.monthlyPaye).toBeCloseTo(2_500, 2);
  });
  it('with no time worked over the rate in the month, the rate decides (tables)', () => {
    const basicOnly: MonthEarlierLines = { uifRemuneration: 3_033, eti: 0, etiComponents: [earning('basic', '3601', 3_033)] };
    expect(bonusLine(10_000, basicOnly, undefined, partTime).paye.monthlyPaye).not.toBeCloseTo(2_500, 2);
  });
});

// Review follow-up on ed7bdab53e: only the regular line's RECURRING time-worked pay classifies the bonus, as on the
// regular line itself (timeWorkedEarnings): a once-off 3601 there is recorded on its breakdown item (onceOff) and
// left out when the earlier lines are rebuilt.
describe('the employment class across the month: a once-off basic pay item does not count (review of ed7bdab53e)', () => {
  const partTime = employee({ payBasis: 'daily', hoursPerWeek: 14, hoursPerDay: 6, dailyRate: 300 });
  it('a once-off 3601 on the regular line is flagged on its breakdown, and the rebuild leaves it out', () => {
    const onceOff: EmployeeComponent = { ...earning('extra', '3601', 1_517), isRecurring: false };
    const regular = calculatePayrollLine({ employee: partTime, components: [earning('basic', '3601', 3_033), onceOff], period, taxYear: 2027, annualPayrollEstimate: 1_000_000 });
    expect(regular.componentBreakdown.find((i) => i.componentId === 'extra')).toMatchObject({ onceOff: true });
    expect(regular.componentBreakdown.find((i) => i.componentId === 'basic')?.onceOff).toBeUndefined();
    const rebuilt = earningsOfBreakdown(regular.componentBreakdown.map((i) => ({ ...i, isEarning: true })));
    expect(rebuilt.find((c) => c.component.id === 'extra')?.isRecurring).toBe(false);
    // R3 033 recurring over 10.11 days is R300 a day: deemed standard (tables), as the regular line was.
    const bonus = bonusLine(10_000, { uifRemuneration: 4_550, eti: 0, etiComponents: rebuilt }, undefined, partTime);
    expect(bonus.paye.monthlyPaye).not.toBeCloseTo(2_500, 2);
  });
});

// Gate ruling 1 on e0eec1dea1: a regular line costed before the onceOff marker whose once-off pay cannot be told from
// its recurring pay (payrollOffCycleMonthRead: storedClass) is not reclassified: the bonus takes that line's class.
describe('a historical regular line that cannot be rebuilt: its stored class (review of e0eec1dea1)', () => {
  const partTime = employee({ payBasis: 'daily', hoursPerWeek: 14, hoursPerDay: 6, dailyRate: 300 });
  const treatmentOf = (l: ReturnType<typeof regularLine>) => l.explanations.paye.steps.find((s) => s.key === 'paye.treatment')?.label;
  it('stored on the tables: the bonus is on the tables, whatever the rebuilt earnings say', () => {
    const month = [earning('basic', '3601', 3_033), earning('overtime', '3607', 1_517)]; // R450 a day if all counted
    const bonus = bonusLine(10_000, { uifRemuneration: 4_550, eti: 0, etiComponents: month, storedClass: 'tables' }, undefined, partTime);
    expect(treatmentOf(bonus)).toMatch(/Taxed on the SARS tables/);
  });
  it('stored as flat: the bonus is non-standard too', () => {
    const bonus = bonusLine(10_000, { uifRemuneration: 3_033, eti: 0, etiComponents: [earning('basic', '3601', 3_033)], storedClass: 'flat' }, undefined, partTime);
    expect(treatmentOf(bonus)).toMatch(/Non-standard employment/);
  });
});
