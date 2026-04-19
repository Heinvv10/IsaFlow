import { describe, it, expect } from 'vitest';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import type { PayrollLineInput, PayrollEmployee, EmployeeComponent, PayrollComponent } from '@/modules/accounting/services/payroll/payrollTypes';

function makeEmployee(overrides: Partial<PayrollEmployee> = {}): PayrollEmployee {
  return {
    id: 'emp-1',
    companyId: 'co-1',
    employeeNumber: 'E001',
    firstName: 'Test',
    lastName: 'Employee',
    idNumber: '9001015009087',
    taxNumber: '1234567890',
    employmentType: 'permanent',
    startDate: new Date('2023-01-01'),
    dateOfBirth: new Date('1990-01-01'),
    uifExcluded: false,
    medicalAidMainMember: true,
    medicalAidDependantsCount: 0,
    ...overrides,
  };
}

function makeComponent(overrides: Partial<PayrollComponent> = {}): PayrollComponent {
  return {
    id: 'comp-1',
    name: 'Basic Salary',
    sarsSourceCode: '3601',
    componentType: 'earning',
    isTaxable: true,
    isUifApplicable: true,
    isSdlApplicable: true,
    ...overrides,
  };
}

function makeInput(grossSalary: number, annualPayroll = 1_000_000): PayrollLineInput {
  return {
    employee: makeEmployee(),
    components: [{ component: makeComponent(), amount: grossSalary }],
    period: { month: 6, year: 2024 },
    taxYear: 2025,
    annualPayrollEstimate: annualPayroll,
  };
}

describe('payrollCalculator — property tests', () => {
  it('gross pay equals sum of earning components', () => {
    const result = calculatePayrollLine(makeInput(25_000));
    expect(result.grossPay).toBeCloseTo(25_000, 2);
  });

  it('net pay = gross - PAYE - employee UIF', () => {
    const result = calculatePayrollLine(makeInput(25_000));
    const expectedNet = result.grossPay - result.paye.monthlyPaye - result.uif.employeeContribution;
    expect(result.netPay).toBeCloseTo(expectedNet, 2);
  });

  it('PAYE is never negative', () => {
    const result = calculatePayrollLine(makeInput(5_000));
    expect(result.paye.monthlyPaye).toBeGreaterThanOrEqual(0);
  });

  it('SDL is zero when annual payroll below threshold', () => {
    const result = calculatePayrollLine(makeInput(25_000, 300_000));
    expect(result.sdl).toBe(0);
  });

  it('SDL is 1% when annual payroll above threshold', () => {
    const result = calculatePayrollLine(makeInput(25_000, 1_000_000));
    expect(result.sdl).toBeCloseTo(250, 2);
  });

  it('deduction component reduces taxable income', () => {
    const emp = makeEmployee();
    const salary: EmployeeComponent = { component: makeComponent(), amount: 25_000 };
    const pension: EmployeeComponent = {
      component: makeComponent({
        id: 'comp-2', name: 'Pension Fund', sarsSourceCode: '4001',
        componentType: 'deduction', isUifApplicable: false, isSdlApplicable: false,
      }),
      amount: 2_000,
    };
    const result = calculatePayrollLine({
      employee: emp,
      components: [salary, pension],
      period: { month: 6, year: 2024 },
      taxYear: 2025,
      annualPayrollEstimate: 1_000_000,
    });
    expect(result.taxableIncome).toBeCloseTo(23_000, 2);
    expect(result.grossPay).toBeCloseTo(25_000, 2);
  });

  it('non-taxable earning does not affect PAYE', () => {
    const taxableBase = calculatePayrollLine(makeInput(25_000)).paye.monthlyPaye;
    const emp = makeEmployee();
    const salary: EmployeeComponent = { component: makeComponent(), amount: 25_000 };
    const reimbursement: EmployeeComponent = {
      component: makeComponent({
        id: 'comp-reim', name: 'Reimbursement', sarsSourceCode: '3713',
        componentType: 'earning', isTaxable: false, isUifApplicable: false, isSdlApplicable: false,
      }),
      amount: 3_000,
    };
    const result = calculatePayrollLine({
      employee: emp,
      components: [salary, reimbursement],
      period: { month: 6, year: 2024 },
      taxYear: 2025,
      annualPayrollEstimate: 1_000_000,
    });
    expect(result.paye.monthlyPaye).toBeCloseTo(taxableBase, 1);
  });

  it('component breakdown includes all components', () => {
    const result = calculatePayrollLine(makeInput(25_000));
    expect(result.componentBreakdown).toHaveLength(1);
    expect(result.componentBreakdown[0].amount).toBe(25_000);
  });

  it('employee id is preserved in result', () => {
    const result = calculatePayrollLine(makeInput(25_000));
    expect(result.employeeId).toBe('emp-1');
  });
});
