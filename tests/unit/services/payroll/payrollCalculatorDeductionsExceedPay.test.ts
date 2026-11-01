/**
 * DEDUCTIONS_EXCEED_PAY only reports. Net stays floored at nil and no figure the
 * calculator computes moves, so these pin the exact figures of a known fixture
 * as well as the new code. They were read off the calculator before the code existed.
 */
import { describe, it, expect } from 'vitest';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import type { PayrollComponent, PayrollEmployee, PayrollLineInput } from '@/modules/accounting/services/payroll/payrollTypes';

const employee: PayrollEmployee = {
  id: 'emp-1', companyId: 'co-1', employeeNumber: 'E001', firstName: 'Test', lastName: 'Employee',
  idNumber: '9001015009087', taxNumber: '1234567890', employmentType: 'permanent',
  startDate: new Date('2020-01-01'), dateOfBirth: new Date('1980-01-01'), uifExcluded: false,
  medicalAidMainMember: true, medicalAidDependantsCount: 0,
};
const component = (over: Partial<PayrollComponent>): PayrollComponent => ({
  id: 'c', name: 'Basic Salary', sarsSourceCode: '3601', componentType: 'earning',
  isTaxable: true, isUifApplicable: true, isSdlApplicable: true, ...over,
});
const salary = { component: component({ id: 'salary' }), amount: 20000 };
const dues = (amount: number) => ({
  component: component({ id: 'dues', name: 'Union dues', sarsSourceCode: 'UNION', componentType: 'deduction', isTaxable: false, isUifApplicable: false, isSdlApplicable: false }),
  amount,
});
const run = (components: PayrollLineInput['components']) => calculatePayrollLine({
  employee, components, period: { month: 11, year: 2026 }, taxYear: 2027, annualPayrollEstimate: 1_000_000,
});
const codes = (r: ReturnType<typeof run>) => r.validationResults.map((v) => v.code);

describe('DEDUCTIONS_EXCEED_PAY', () => {
  it('a normal line carries no code and the figures of the known fixture', () => {
    const r = run([salary, dues(200)]);
    expect(codes(r)).toEqual([]);
    expect({ paye: r.paye.monthlyPaye, uifEmployee: r.uif.employeeContribution, uifEmployer: r.uif.employerContribution, sdl: r.sdl, net: r.netPay, gross: r.grossPay })
      .toEqual({ paye: 1739, uifEmployee: 177.12, uifEmployer: 177.12, sdl: 200, net: 17883.88, gross: 20000 });
  });

  it('net exactly nil is not a shortfall', () => {
    const { netPay } = run([salary]);
    const r = run([salary, dues(netPay)]);
    expect(r.netPay).toBe(0);
    expect(codes(r)).toEqual([]);
  });

  it('one cent over reports the raw net and leaves every figure as it was', () => {
    const { netPay } = run([salary]);
    const r = run([salary, dues(netPay + 0.01)]);
    expect(r.netPay).toBe(0);
    expect(r.validationResults).toMatchObject([{ code: 'DEDUCTIONS_EXCEED_PAY', severity: 'error', rawNet: -0.01 }]);
  });

  it('R30 000 of dues on R20 000 of salary: PAYE, UIF and SDL do not move, net stays floored at nil', () => {
    const plain = run([salary]);
    const over = run([salary, dues(30000)]);
    expect(over.netPay).toBe(0);
    expect(over.paye).toEqual(plain.paye);
    expect(over.uif).toEqual(plain.uif);
    expect(over.sdl).toBe(plain.sdl);
    const warning = over.validationResults[0]!;
    expect(warning).toMatchObject({ code: 'DEDUCTIONS_EXCEED_PAY', rawNet: -11916.12 });
    expect(warning.message.replace(/\s/g, ' ')).toContain('R 11 916.12');
  });
});
