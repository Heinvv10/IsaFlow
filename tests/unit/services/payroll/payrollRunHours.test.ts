/**
 * Hours and days per run (master plan wave 5, HD): the amount is quantity x rate to the cent, an hourly or daily
 * employee with no quantity is never paid as if the quantity were nil, and the quantity reaches the breakdown.
 * Sources: BCEA s33 (hours worked recorded for the payslip); e@syFile pay-period rules are not changed here.
 */
import { describe, it, expect } from 'vitest';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import {
  hoursAmountCents, hoursValidation, maxQuantity, runHoursOf, rateOf,
} from '@/modules/accounting/services/payroll/payrollRunHours';
import { anchorOf, hoursComponentOf } from '@/modules/accounting/services/payroll/payrollRunHoursRead';
import type { EmployeeComponent, PayrollComponent, PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';

const basic: PayrollComponent = {
  id: 'c-3601', name: 'Basic Salary', sarsSourceCode: '3601', componentType: 'earning',
  isTaxable: true, isUifApplicable: true, isSdlApplicable: true,
};
const employee = (extra: Partial<PayrollEmployee> = {}): PayrollEmployee => ({
  id: 'e1', companyId: 'co', employeeNumber: 'E1', idNumber: '8001015009087', firstName: 'Thandi', lastName: 'Zulu', employmentType: 'permanent',
  startDate: new Date(2025, 0, 1), uifExcluded: false, medicalAidMainMember: false, medicalAidDependantsCount: 0,
  s18aReceiptHeld: false, taxStatus: 'employee', payBasis: 'hourly', hourlyRate: 85.5, dailyRate: null,
  hoursPerWeek: 40, hoursPerDay: 8, ...extra,
});
const worked = (quantity: number, quantityUnit: 'hour' | 'day', amount: number): EmployeeComponent => ({
  component: basic, amount, isRecurring: false, quantity, quantityUnit,
});
const codes = (e: PayrollEmployee, c: EmployeeComponent[]) => hoursValidation(e, c).map((v) => v.code);

describe('amount = quantity x rate, to the cent', () => {
  it('rounds half a cent up on the exact product, not on a float', () => {
    expect(hoursAmountCents(7.5, 85.5)).toBe(64125);
    expect(hoursAmountCents(0.01, 0.5)).toBe(1); // 0.005 rand rounds up
    expect(hoursAmountCents(173.33, 85.55)).toBe(1482838); // 14 828.3815
    expect(hoursAmountCents(3, 0.1)).toBe(30); // 0.1 * 3 is 0.30000000000000004 in floats
  });
  it('knows the rate by pay basis and the most a month can hold', () => {
    expect(rateOf(employee())).toBe(85.5);
    expect(rateOf(employee({ payBasis: 'daily', dailyRate: 640 }))).toBe(640);
    expect(rateOf(employee({ payBasis: 'monthly' }))).toBeNull();
    expect(maxQuantity('hour')).toBe(744);
    expect(maxQuantity('day')).toBe(31);
  });
});

describe('run hours', () => {
  it('hourly: the hours; daily: days x hours per day; missing is null, never 0', () => {
    expect(runHoursOf(employee(), [worked(160, 'hour', 13680)])).toBe(160);
    expect(runHoursOf(employee({ payBasis: 'daily', dailyRate: 640 }), [worked(20, 'day', 12800)])).toBe(160);
    expect(runHoursOf(employee({ payBasis: 'daily', dailyRate: 640, hoursPerDay: null }), [worked(20, 'day', 12800)])).toBeNull();
    expect(runHoursOf(employee(), [])).toBeNull();
    expect(runHoursOf(employee({ payBasis: 'monthly' }), [worked(160, 'hour', 13680)])).toBeNull();
  });
  it('an entered nil is 0 hours (said, not defaulted); two rows cannot be told, never summed', () => {
    expect(runHoursOf(employee(), [worked(0, 'hour', 0)])).toBe(0);
    expect(runHoursOf(employee(), [worked(80, 'hour', 6840), worked(80, 'hour', 6840)])).toBeNull();
  });
});

describe('validation', () => {
  it('an hourly employee with no hours is an error naming them, and a daily one asks for days', () => {
    const [v] = hoursValidation(employee(), []);
    expect(v).toMatchObject({ code: 'HOURS_MISSING', severity: 'error' });
    expect(v!.message).toContain('Thandi Zulu');
    expect(v!.message).toContain('hours');
    expect(hoursValidation(employee({ payBasis: 'daily', dailyRate: 640 }), [])[0]!.message).toContain('days');
  });
  it('hours kept after the employee moved to days are a mismatch, and the days are still missing', () => {
    expect(codes(employee({ payBasis: 'daily', dailyRate: 640 }), [worked(160, 'hour', 13680)])).toEqual(['HOURS_UNIT_MISMATCH', 'HOURS_MISSING']);
  });
  it('hours left on an employee who moved to monthly are a mismatch beside the recurring salary (R15 000 + R14 834.25)', () => {
    const monthly = employee({ payBasis: 'monthly', hourlyRate: null });
    const salary: EmployeeComponent = { component: basic, amount: 15000, isRecurring: true };
    const found = hoursValidation(monthly, [salary, worked(173.5, 'hour', 14834.25)]);
    expect(found.map((v) => [v.code, v.severity])).toEqual([['HOURS_UNIT_MISMATCH', 'error']]);
    expect(found[0]!.message).toContain('monthly');
  });
  it('a monthly employee is never asked for hours', () => {
    expect(codes(employee({ payBasis: 'monthly' }), [])).toEqual([]);
  });
  it('a nil entry counts as entered', () => {
    expect(codes(employee(), [worked(0, 'hour', 0)])).toEqual([]);
  });
  it('other earnings, 3601 or not, beside the hours are ordinary pay: a R500 allowance and a -R500 correction on other components', () => {
    const shift = { ...basic, id: 'c-shift', name: 'Shift allowance' };
    for (const amount of [500, -500]) {
      const other: EmployeeComponent = { component: shift, amount, isRecurring: false };
      expect(codes(employee(), [worked(160, 'hour', 13680), other])).toEqual([]);
    }
  });
  it('a recurring 3601 on another component is a warning only (a possible double salary after a basis switch)', () => {
    const fixed = { ...basic, id: 'c-fixed', name: 'Fixed allowance' };
    const found = hoursValidation(employee(), [worked(160, 'hour', 13680), { component: fixed, amount: 1000, isRecurring: true }]);
    expect(found.map((v) => [v.code, v.severity])).toEqual([['HOURS_WITH_RECURRING_3601', 'warning']]);
    expect(found[0]!.message).toContain('Fixed allowance');
    expect(codes(employee(), [worked(160, 'hour', 13680), { component: fixed, amount: 1000, isRecurring: false }])).toEqual([]);
    expect(codes(employee(), [worked(160, 'hour', 13680), { component: { ...fixed, sarsSourceCode: '3607' }, amount: 1000, isRecurring: true }])).toEqual([]);
  });
  it('two rows recording hours are an error naming the component, not a sum', () => {
    const wages = { ...basic, name: 'Wages' };
    const two: EmployeeComponent[] = [{ ...worked(80, 'hour', 6840), component: wages }, { ...worked(80, 'hour', 6840), component: wages }];
    expect(codes(employee(), two)).toEqual(['HOURS_DUPLICATE']);
    expect(hoursValidation(employee(), two)[0]!.message).toContain('2 rows recording hours this month (on Wages)');
    const mixed: EmployeeComponent[] = [{ ...worked(80, 'hour', 6840), component: wages }, worked(80, 'hour', 6840)];
    expect(hoursValidation(employee(), mixed)[0]!.message).toContain('(on Basic Salary and Wages)');
    expect(codes(employee(), [worked(80, 'hour', 6840), worked(80, 'hour', 6840)])).toEqual(['HOURS_DUPLICATE']);
  });
  it('a rate changed since the hours were entered is a warning, the stored amount stays the pay', () => {
    expect(codes(employee(), [worked(160, 'hour', 13600)])).toEqual(['HOURS_RATE_CHANGED']);
    expect(codes(employee(), [worked(160, 'hour', 13680)])).toEqual([]); // 160 x 85.50, by hand
  });
  it('any other Basic Salary row beside the hours is a blocking error: it pays twice', () => {
    const recurring: EmployeeComponent = { component: basic, amount: 5000, isRecurring: true };
    const plainOnce: EmployeeComponent = { component: basic, amount: 700, isRecurring: false };
    for (const other of [recurring, plainOnce]) {
      const found = hoursValidation(employee(), [worked(160, 'hour', 13680), other]);
      expect(found.map((v) => [v.code, v.severity])).toEqual([['HOURS_WITH_OTHER_BASIC', 'error']]);
    }
    expect(codes(employee(), [worked(160, 'hour', 13680), { component: basic, amount: 0, isRecurring: true }])).toEqual([]);
  });
});

describe('through the calculator', () => {
  it('the breakdown carries the quantity, unit and the rate paid; the line carries the hours', () => {
    const line = calculatePayrollLine({
      employee: employee(), components: [worked(160, 'hour', 13680)], period: { month: 11, year: 2026 },
      taxYear: 2027, annualPayrollEstimate: 'defer',
    });
    expect(line.componentBreakdown[0]).toMatchObject({ amount: 13680, quantity: 160, quantityUnit: 'hour', rate: 85.5 });
    expect(line.hours).toBe(160);
    expect(line.grossPay).toBe(13680);
  });
  it('a nil entry pays nothing, keeps the quantity 0 on the breakdown with no rate, and is not flagged', () => {
    const line = calculatePayrollLine({
      employee: employee(), components: [worked(0, 'hour', 0)], period: { month: 11, year: 2026 }, taxYear: 2027, annualPayrollEstimate: 'defer',
    });
    expect(line.componentBreakdown[0]).toEqual(expect.objectContaining({ amount: 0, quantity: 0, quantityUnit: 'hour' }));
    expect(line.componentBreakdown[0]).not.toHaveProperty('rate');
    expect(line.hours).toBe(0);
    expect(line.validationResults.filter((v) => v.code.startsWith('HOURS_'))).toEqual([]);
  });
  it('a severance-only leaver is not judged on hours', () => {
    const line = calculatePayrollLine({
      employee: employee(), components: [], period: { month: 11, year: 2026 }, taxYear: 2027, annualPayrollEstimate: 'defer',
      notEmployedInPeriod: true,
    });
    expect(line.validationResults.map((v) => v.code)).not.toContain('HOURS_MISSING');
    expect(line.hours).toBeNull();
  });
  it('no hours: no pay is invented, hours is null and the line is flagged', () => {
    const line = calculatePayrollLine({
      employee: employee(), components: [], period: { month: 11, year: 2026 }, taxYear: 2027, annualPayrollEstimate: 'defer',
    });
    expect(line.grossPay).toBe(0);
    expect(line.hours).toBeNull();
    expect(line.validationResults.map((v) => v.code)).toContain('HOURS_MISSING');
  });
});

describe('ETI by the run\'s hours (ET: s7(5) gross-up and gross-down; ETI guide Issue 5 §5.3)', () => {
  const young = (extra: Partial<PayrollEmployee> = {}) => employee({
    dateOfBirth: new Date(2004, 5, 1), idNumber: '0406015009086', startDate: new Date(2026, 0, 1), hourlyRate: 35, ...extra,
  });
  const run = (e: PayrollEmployee, c: EmployeeComponent[]) => calculatePayrollLine({
    employee: e, components: c, period: { month: 11, year: 2026 }, taxYear: 2027, annualPayrollEstimate: 'defer',
  });
  const codesOf = (l: ReturnType<typeof run>) => l.validationResults.map((v) => v.code);

  it('80 hours at R35: R2 800 grosses up to R5 600, R1 425 x 80/160 = R712.50', () => {
    const hourly = run(young(), [worked(80, 'hour', 2800)]);
    expect(hourly.eti.monthlyEti).toBe(712.5);
    expect(codesOf(hourly)).not.toContain('ETI_HOURS_UNKNOWN');
  });
  it('160 hours keeps the table value; 80 hours at R30 is under the R30.23 minimum wage: nil', () => {
    expect(run(young(), [worked(160, 'hour', 5600)]).eti.monthlyEti).toBe(1425);
    expect(run(young({ hourlyRate: 30 }), [worked(80, 'hour', 2400)]).eti.monthlyEti).toBe(0);
  });
  it('days with no hours per day cannot be told: none is claimed and the line says why', () => {
    const daily = run(young({ payBasis: 'daily', dailyRate: 280, hoursPerDay: null }), [worked(10, 'day', 2800)]);
    expect(daily.eti.monthlyEti).toBe(0);
    expect(codesOf(daily)).toContain('ETI_HOURS_UNKNOWN');
  });
  it('a monthly employee with no hours a week keeps today\'s figure and is warned; with hours a week it is tested', () => {
    const unknown = run(young({ payBasis: 'monthly', hoursPerWeek: null }), [{ component: basic, amount: 2400, isRecurring: true }]);
    expect(unknown.eti.monthlyEti).toBe(1440); // 60% x R2 400, as before ET
    expect(codesOf(unknown)).toContain('ETI_HOURS_UNKNOWN');
    const known = run(young({ payBasis: 'monthly', hoursPerWeek: 40 }), [{ component: basic, amount: 2400, isRecurring: true }]);
    expect(known.eti.monthlyEti).toBe(0); // R2 400 for 173.33 h is under the minimum wage
    expect(codesOf(known)).not.toContain('ETI_HOURS_UNKNOWN');
  });
});

describe('the hours component is found by id among the 3601 earnings, never first-matched', () => {
  const c = (id: string, name: string, code = '3601') => ({ id, name, sarsSourceCode: code, componentType: 'earning' });
  it('the only one; the one named Basic Salary among several; else a refusal naming them', () => {
    expect(hoursComponentOf([c('a', 'Pay'), c('o', 'Overtime', '3607')])).toEqual({ component: c('a', 'Pay') });
    expect(hoursComponentOf([c('s', 'Shift allowance'), c('b', 'Basic Salary')])).toEqual({ component: c('b', 'Basic Salary') });
    expect(hoursComponentOf([c('x', 'Salary A'), c('y', 'Salary B')])).toMatchObject({ problem: expect.stringContaining('Salary A, Salary B') });
    expect(hoursComponentOf([c('o', 'Overtime', '3607')])).toMatchObject({ problem: expect.stringContaining('no active taxable Basic Salary') });
    expect(hoursComponentOf([c('b1', 'Basic Salary'), c('b2', ' basic salary ')])).toMatchObject({ problem: expect.any(String) });
  });
});

describe('the anchor picker both readers share', () => {
  it('none; one; several: the lowest id, flagged duplicate, in any input order', () => {
    expect(anchorOf([])).toEqual({ componentId: null, duplicate: false });
    expect(anchorOf(['b'])).toEqual({ componentId: 'b', duplicate: false });
    expect(anchorOf(['c', 'a', 'b'])).toEqual({ componentId: 'a', duplicate: true });
    expect(anchorOf(['b', 'a'])).toEqual(anchorOf(['a', 'b']));
    expect(anchorOf(['a', 'a'])).toEqual({ componentId: 'a', duplicate: true });
  });
});
