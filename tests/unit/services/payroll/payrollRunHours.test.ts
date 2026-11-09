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
import type { EmployeeComponent, PayrollComponent, PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';

const basic: PayrollComponent = {
  id: 'c-3601', name: 'Basic Salary', sarsSourceCode: '3601', componentType: 'earning',
  isTaxable: true, isUifApplicable: true, isSdlApplicable: true,
};
const employee = (extra: Partial<PayrollEmployee> = {}): PayrollEmployee => ({
  id: 'e1', companyId: 'co', employeeNumber: 'E1', firstName: 'Thandi', lastName: 'Zulu', employmentType: 'permanent',
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
});

describe('validation', () => {
  it('an hourly employee with no hours is an error naming them, and a daily one asks for days', () => {
    const [v] = hoursValidation(employee(), []);
    expect(v).toMatchObject({ code: 'HOURS_MISSING', severity: 'error' });
    expect(v!.message).toContain('Thandi Zulu');
    expect(v!.message).toContain('hours');
    expect(hoursValidation(employee({ payBasis: 'daily', dailyRate: 640 }), [])[0]!.message).toContain('days');
  });
  it('hours kept after the employee moved to days count as missing', () => {
    expect(codes(employee({ payBasis: 'daily', dailyRate: 640 }), [worked(160, 'hour', 13680)])).toEqual(['HOURS_MISSING']);
  });
  it('a monthly employee is never asked for hours', () => {
    expect(codes(employee({ payBasis: 'monthly' }), [])).toEqual([]);
  });
  it('a rate changed since the hours were entered is a warning, the stored amount stays the pay', () => {
    expect(codes(employee(), [worked(160, 'hour', 13600)])).toEqual(['HOURS_RATE_CHANGED']);
    expect(codes(employee(), [worked(160, 'hour', hoursAmountCents(160, 85.5) / 100)])).toEqual([]);
  });
  it('a recurring Basic Salary on top of hours is warned: it pays twice', () => {
    const recurring: EmployeeComponent = { component: basic, amount: 5000, isRecurring: true };
    expect(codes(employee(), [worked(160, 'hour', 13680), recurring])).toContain('HOURS_WITH_RECURRING_BASIC');
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
  it('no hours: no pay is invented, hours is null and the line is flagged', () => {
    const line = calculatePayrollLine({
      employee: employee(), components: [], period: { month: 11, year: 2026 }, taxYear: 2027, annualPayrollEstimate: 'defer',
    });
    expect(line.grossPay).toBe(0);
    expect(line.hours).toBeNull();
    expect(line.validationResults.map((v) => v.code)).toContain('HOURS_MISSING');
  });
});
