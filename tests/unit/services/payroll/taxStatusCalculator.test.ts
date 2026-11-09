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
