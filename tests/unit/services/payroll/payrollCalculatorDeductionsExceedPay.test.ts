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
const instalment = (amount: number) => ({
  component: component({ id: 'loan', name: 'Loan repayment', sarsSourceCode: 'LOAN', componentType: 'deduction', isTaxable: false, isUifApplicable: false, isSdlApplicable: false }),
  amount,
});
const fringe = (amount: number) => ({
  component: component({
    id: 'fringe', name: 'Low-interest loan benefit', sarsSourceCode: '3801',
    isUifApplicable: false, isSdlApplicable: true,
  }),
  amount,
  isNonCash: true,
});
const run = (components: PayrollLineInput['components']) => calculatePayrollLine({
  employee, components, period: { month: 11, year: 2026 }, taxYear: 2027, annualPayrollEstimate: 1_000_000,
});
const codes = (r: ReturnType<typeof run>) => r.validationResults.map((v) => v.code);

describe('LOAN_INSTALMENT_EXCEEDS_PAY', () => {
  const { netPay: net } = run([salary]);

  it('a shortfall that would not exist without the instalment is blocked for manual review', () => {
    const plain = run([salary]);
    const over = run([salary, instalment(30000)]);
    expect(over.validationResults).toMatchObject([{ code: 'LOAN_INSTALMENT_EXCEEDS_PAY', severity: 'error', rawNet: -11916.12 }]);
    expect(over.validationResults[0]!.message).toContain('blocked for manual review');
    expect(over.netPay).toBe(0);
    expect(over.paye).toEqual(plain.paye);
    expect(over.uif).toEqual(plain.uif);
    expect(over.sdl).toBe(plain.sdl);
  });

  it('other deductions that use up exactly the net leave the shortfall the instalment\'s', () => {
    expect(codes(run([salary, dues(net), instalment(100)]))).toEqual(['LOAN_INSTALMENT_EXCEEDS_PAY']);
  });

  it('one cent more and the shortfall would exist without it: it stays DEDUCTIONS_EXCEED_PAY', () => {
    expect(codes(run([salary, dues(net + 0.01), instalment(100)]))).toEqual(['DEDUCTIONS_EXCEED_PAY']);
  });

  it('an instalment net pay can carry reports nothing', () => {
    expect(codes(run([salary, instalment(net)]))).toEqual([]);
  });

  it.each([
    ['under', 1000],
    ['equal', net],
    ['blocked', 30000],
  ])('keeps PAYE, UIF and SDL from the 3801 benefit when the cash instalment is %s', (_case, amount) => {
    const benefitOnly = run([salary, fringe(212.5)]);
    const withCashInstalment = run([salary, fringe(212.5), instalment(amount)]);
    expect({
      paye: withCashInstalment.paye,
      uif: withCashInstalment.uif,
      sdl: withCashInstalment.sdl,
      taxableIncome: withCashInstalment.taxableIncome,
    }).toEqual({
      paye: benefitOnly.paye,
      uif: benefitOnly.uif,
      sdl: benefitOnly.sdl,
      taxableIncome: benefitOnly.taxableIncome,
    });
  });
});

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

describe('a LOAN deduction is never a tax deduction (Hein: a taxable LOAN is refused)', () => {
  it('flagged taxable, it leaves PAYE, UIF and SDL as they are and only lowers net', () => {
    const taxed = { ...instalment(1000), component: { ...instalment(1000).component, isTaxable: true } };
    const plain = run([salary]);
    const r = run([salary, taxed]);
    expect(r.paye).toEqual(plain.paye);
    expect(r.taxableIncome).toBe(plain.taxableIncome);
    expect(r.uif).toEqual(plain.uif);
    expect(r.netPay).toBe(Math.round((plain.netPay - 1000) * 100) / 100);
    expect(r.componentBreakdown.find((b) => b.componentId === 'loan')).toMatchObject({ isTaxable: false });
  });

  it('a LOAN-coded EARNING keeps its taxable flag: the override is for the deduction only', () => {
    const earning = { component: component({ id: 'loan-earning', sarsSourceCode: 'LOAN', componentType: 'earning', isTaxable: true }), amount: 500 };
    expect(run([salary, earning]).componentBreakdown.find((b) => b.componentId === 'loan-earning')).toMatchObject({ isTaxable: true });
  });

  it('any other taxable deduction does not come off PAYE income either (para 2(4)), and says so', () => {
    const sacrifice = { ...dues(1000), component: { ...dues(1000).component, sarsSourceCode: 'SACR', isTaxable: true } };
    const r = run([salary, sacrifice]);
    expect(r.paye.monthlyPaye).toBe(run([salary]).paye.monthlyPaye);
    expect(r.validationResults.find(v => v.code === 'DEDUCTION_NOT_PAYE_DEDUCTIBLE')?.message).toContain('code SACR');
  });
});
