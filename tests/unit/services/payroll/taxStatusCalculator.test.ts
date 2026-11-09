/**
 * calculatePayrollLine under tax status and employment class (TS-b). Sources: PAYE-GEN-01-G21 (2027) Rev 1 p. 26 (contractor),
 * p. 27 (director), p. 28 (non-standard: 25% of the balance of remuneration).
 */
import { describe, expect, it } from 'vitest';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import type { EmployeeComponent, PayeYearToDate, PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';

const employee = (o: Partial<PayrollEmployee> = {}): PayrollEmployee => ({
  id: 'e1', companyId: 'c', employeeNumber: '1', firstName: 'A', lastName: 'B', employmentType: 'permanent',
  startDate: new Date(2020, 2, 1), dateOfBirth: new Date(1986, 0, 1), uifExcluded: false, medicalAidMainMember: false,
  medicalAidDependantsCount: 0, s18aReceiptHeld: false, taxStatus: 'employee', payBasis: 'monthly', ...o,
});
const earn = (amount: number, code = '3601'): EmployeeComponent => ({
  component: { id: `c-${code}`, name: 'Pay', sarsSourceCode: code, componentType: 'earning', isTaxable: true, isUifApplicable: true, isSdlApplicable: true }, amount,
});
const deduct = (amount: number, code: string): EmployeeComponent => ({
  component: { id: `d-${code}`, name: 'Ded', sarsSourceCode: code, componentType: 'deduction', isTaxable: true, isUifApplicable: false, isSdlApplicable: false }, amount,
});
const cost = (e: PayrollEmployee, components: EmployeeComponent[], ytd?: PayeYearToDate) => calculatePayrollLine({
  employee: e, components, period: { year: 2026, month: 3 }, taxYear: 2027, annualPayrollEstimate: 1_000_000, ytd,
});
const FLAT = { payBasis: 'daily' as const, hoursPerWeek: 14, hoursPerDay: 6, dailyRate: 500 };
const YTD: PayeYearToDate = { periods: 5, periodicTaxable: 100_000, annualPayments: 0, tablePaye: 9_000, medicalCredit: 0, additionalMedicalCredit: 0, medicalSchemeFees: 0,
  sdlApplicable: 0, sdlLeviable: 0, sdlRetirementDeduction: 0 };

describe('non-standard employment: 25% of the balance of remuneration (G21 p. 28)', () => {
  it('R5 000 is R1 250.00, with UIF 50, SDL 50 and the flag', () => {
    const r = cost(employee(FLAT), [earn(5_000)]);
    expect([r.paye.monthlyPaye, r.payeSplit.regular, r.uif.employeeContribution, r.sdl]).toEqual([1_250, 1_250, 50, 50]);
    expect(r.validationResults.find(v => v.code === 'PAYE_OUTSIDE_TABLES')?.treatment).toBe('flat_25');
  });

  it('is the same with a year to date: the flat month never reads it', () => {
    expect(cost(employee(FLAT), [earn(5_000)], YTD).paye.monthlyPaye).toBe(1_250);
  });

  it('a year to date does not widen the s11F cap of a flat month (27.5% of R5 000 = R1 375 comes off, R906.25 is taxed)', () => {
    // Read as a table month with this year to date, R5 000 of contributions would all be allowed (to date, 6 periods of a bigger base): PAYE nil.
    const pay = [earn(5_000), deduct(5_000, '4001')];
    expect(cost(employee(FLAT), pay).paye.monthlyPaye).toBe(906.25);
    expect(cost(employee(FLAT), pay, YTD).paye.monthlyPaye).toBe(906.25);
    expect(cost(employee({ hoursPerWeek: 40 }), pay, YTD).paye.monthlyPaye).not.toBe(906.25);
  });

  it('is on the balance after a retirement contribution (the allowed deduction), and gives no medical credit', () => {
    const r = cost(employee({ ...FLAT, medicalAidMainMember: true }), [earn(5_000), deduct(500, '4001'), deduct(300, '4005')]);
    expect(r.paye.monthlyPaye).toBe(1_125); // 25% x (5 000 - 500)
    expect([r.medicalCredit, r.additionalMedicalCredit]).toEqual([0, 0]);
  });

  it('a directive on a lump sum stands beside it', () => {
    const lump: EmployeeComponent = { ...earn(10_000, '3901'), directive: { id: 'd', number: 'D1', paye: 2_000 } } as unknown as EmployeeComponent;
    const r = cost(employee(FLAT), [earn(5_000), lump]);
    expect(r.payeSplit.directive).toBe(2_000);
  });

  it('the same pay on a standard employee is taxed from the tables (nil under the threshold)', () => {
    expect(cost(employee({ hoursPerWeek: 22 }), [earn(5_000)]).paye.monthlyPaye).toBe(0);
  });
});

describe('independent contractor: no PAYE, UIF, SDL or ETI (G21 p. 26)', () => {
  it('R7 000 pays R7 000, with the flag and no ETI', () => {
    const r = cost(employee({ taxStatus: 'independent_contractor', dateOfBirth: new Date(2004, 0, 1) }), [earn(7_000)]);
    expect([r.paye.monthlyPaye, r.uif.employeeContribution, r.uif.employerContribution, r.sdl, r.sdlLeviable, r.sdlApplicable, r.eti.monthlyEti, r.netPay])
      .toEqual([0, 0, 0, 0, 0, 0, 0, 7_000]);
    expect(r.validationResults.find(v => v.code === 'PAYE_OUTSIDE_TABLES')?.treatment).toBe('none');
  });

  it('default earnings (UIF and SDL flagged on, as the company components are) still give UIF = SDL = 0, with the named warning', () => {
    const r = cost(employee({ taxStatus: 'independent_contractor' }), [earn(7_000)]);
    expect(earn(7_000).component.isUifApplicable && earn(7_000).component.isSdlApplicable).toBe(true);
    expect([r.uif.employeeContribution, r.uif.employerContribution, r.sdl]).toEqual([0, 0, 0]);
    const w = r.validationResults.find(v => v.code === 'CONTRACTOR_UIF_SDL_IGNORED');
    expect(w?.severity).toBe('warning');
  });
});

describe('director: on the tables, UIF and SDL as an employee (G21 p. 27)', () => {
  it('costs exactly as an employee does', () => {
    const base = cost(employee(), [earn(50_000)]);
    const dir = cost(employee({ taxStatus: 'director', employmentType: 'director' }), [earn(50_000)]);
    expect([dir.paye.monthlyPaye, dir.uif.employeeContribution, dir.sdl]).toEqual([base.paye.monthlyPaye, base.uif.employeeContribution, base.sdl]);
    expect(dir.paye.monthlyPaye).toBeGreaterThan(0);
  });
});

describe('the terms results ride on the line', () => {
  it('an undetermined hourly employee is costed on the tables and carries a blocking error', () => {
    const r = cost(employee({ payBasis: 'hourly', hourlyRate: 50 }), [earn(5_000)]);
    expect(r.validationResults.map(v => v.code)).toContain('EMPLOYMENT_UNDETERMINED');
  });
  it('a monthly employee with no hours carries the info result and is on the tables', () => {
    const r = cost(employee(), [earn(5_000)]);
    expect(r.validationResults.find(v => v.code === 'HOURS_NOT_RECORDED')?.severity).toBe('info');
    expect(r.paye.monthlyPaye).toBe(0);
  });
});

describe('G21 p. 27-28 summary table: the class AND the PAYE figure, row by row (2027, March 2026)', () => {
  const paye = (e: Partial<PayrollEmployee>, pay: number) => cost(employee(e), [earn(pay)]).paye.monthlyPaye;
  it('row 1: 22 h a week, over the R99 000 threshold: the tables (R12 000 a month = R675.00, not flat R3 000)', () => {
    expect(paye({ hoursPerWeek: 22, hoursPerDay: 4.4 }, 12_000)).toBe(675);
  });
  it('row 2: 22 h a week, within the threshold (R8 250 a month = R99 000 a year): nil', () => {
    expect(paye({ hoursPerWeek: 22, hoursPerDay: 4.4 }, 8_250)).toBe(0);
  });
  it('row 2 against row 1: R1 more a year and the tables start (R8 250.09 a month)', () => {
    expect(paye({ hoursPerWeek: 22, hoursPerDay: 4.4 }, 8_250.09)).toBeGreaterThan(0);
  });
  it('row 3: 5+ h a day under R394, under 22 h a week: nil (deemed standard; the tables give the guide\'s "no tax")', () => {
    expect(paye({ payBasis: 'daily', hoursPerWeek: 21, hoursPerDay: 5, dailyRate: 390 }, 7_020)).toBe(0);
  });
  it('row 4: 5+ h a day over R394: 25% (R5 000 = R1 250.00)', () => {
    expect(paye({ payBasis: 'daily', hoursPerWeek: 14, hoursPerDay: 6, dailyRate: 500 }, 5_000)).toBe(1_250);
  });
  it('row 5: under 5 h a day, under R394: 25% (R4 500 = R1 125.00)', () => {
    expect(paye({ payBasis: 'daily', hoursPerWeek: 14, hoursPerDay: 4, dailyRate: 300 }, 4_500)).toBe(1_125);
  });
  it('under 5 h a day, R394 or more (no printed row): the residual definition, 25% (R4 500)', () => {
    expect(paye({ payBasis: 'daily', hoursPerWeek: 14, hoursPerDay: 4, dailyRate: 450 }, 4_500)).toBe(1_125);
  });
});

describe('what the line pays per day decides the class (A-H1)', () => {
  const R70 = { payBasis: 'hourly' as const, hoursPerWeek: 20, hoursPerDay: 5, hourlyRate: 70 };
  it('R70 an hour, 20 h a week, 5 h days, paid R15 000: flat 25% = R3 750, with the day-pay warning', () => {
    const r = cost(employee(R70), [earn(15_000)]);
    expect(r.paye.monthlyPaye).toBe(3_750);
    expect(r.validationResults.map(v => v.code)).toEqual(expect.arrayContaining(['DAY_PAY_FROM_EARNINGS', 'PAYE_OUTSIDE_TABLES']));
  });
  it('the same terms paid what the rate says (R6 062.50 = R350 x 17.3 days): tables, nil', () => {
    expect(cost(employee(R70), [earn(6_062.5)]).paye.monthlyPaye).toBe(0);
  });
  it('an overtime day lifts R390 over R394: R7 800 on a 20 h, 5 h-day schedule is flat (R1 950), R6 760 is not', () => {
    const t = { payBasis: 'hourly' as const, hoursPerWeek: 20, hoursPerDay: 5, hourlyRate: 78 };
    expect(cost(employee(t), [earn(7_800)]).paye.monthlyPaye).toBe(1_950);
    expect(cost(employee(t), [earn(6_760)]).paye.monthlyPaye).toBe(0);
  });
  it('a bonus (3605, annual payment) is not periodic earnings and does not move the class', () => {
    const t = { payBasis: 'hourly' as const, hoursPerWeek: 20, hoursPerDay: 5, hourlyRate: 78 };
    const r = cost(employee(t), [earn(6_760), earn(20_000, '3605')]);
    expect(r.validationResults.map(v => v.code)).not.toContain('DAY_PAY_FROM_EARNINGS');
    expect(r.validationResults.map(v => v.code)).not.toContain('PAYE_OUTSIDE_TABLES');
  });
});

describe('HOURS_NOT_RECORDED: info for permanent, a warning for contract and casual', () => {
  const sev = (employmentType: PayrollEmployee['employmentType']) =>
    cost(employee({ employmentType }), [earn(5_000)]).validationResults.find(v => v.code === 'HOURS_NOT_RECORDED')?.severity;
  it.each([['permanent', 'info'], ['contract', 'warning'], ['casual', 'warning']] as const)('%s -> %s', (t, severity) => expect(sev(t)).toBe(severity));
});
