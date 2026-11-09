/**
 * How a run puts fringe benefits on the payslip (wave 5 FB review): withFringe's refusal path, and the loan preview
 * seeing the same components as the stored line.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { withFringe } from '@/modules/accounting/services/payroll/payrollRunComponents';
import { judgeLoanApplications } from '@/modules/accounting/services/payroll/payrollRunLoanDecision';
import { appendLoanComponents } from '@/modules/accounting/services/payroll/payrollRunLoanComponents';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import type { FringeBenefit } from '@/modules/accounting/services/payroll/fringeBenefits';
import type { ApplyLoanResult } from '@/modules/accounting/services/payroll/payrollLoanService';
import type { EmployeeComponent, PayrollComponent, PayrollEmployee, ValidationResult } from '@/modules/accounting/services/payroll/payrollTypes';

const comp = (code: string, over: Partial<PayrollComponent> = {}): PayrollComponent => ({
  id: `c-${code}`, name: code, sarsSourceCode: code, componentType: 'earning', isTaxable: true, isUifApplicable: false, isSdlApplicable: false, ...over,
});
const employee: PayrollEmployee = {
  id: 'e1', companyId: 'c1', employeeNumber: '1', firstName: 'A', lastName: 'B', employmentType: 'permanent',
  startDate: new Date(2020, 0, 1), dateOfBirth: new Date(1986, 0, 1), uifExcluded: false, medicalAidMainMember: true, medicalAidDependantsCount: 0, s18aReceiptHeld: false,
};
const period = { year: 2026, month: 3 };
const salary: EmployeeComponent = { component: comp('3601', { isUifApplicable: true }), amount: 40000 };
const vehicle: FringeBenefit = { id: 'b', kind: 'company_vehicle', determinedValue: 400000, maintenancePlan: false, businessUseAtLeast80: false, effectiveFrom: '2026-01-01', effectiveTo: null };

describe('withFringe: a vehicle that cannot be shown', () => {
  it('with the 3802 earning switched off (no component), the benefit is left off with a blocking-coded error, never silently', () => {
    const warnings: ValidationResult[] = [];
    const out = withFringe([salary], [vehicle], null, period, warnings);
    expect(out).toEqual([salary]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: 'FRINGE_BENEFIT_NOT_APPLIED', severity: 'error' });
    expect(warnings[0]?.message).toMatch(/3802/);
  });
  it('applies the benefit and marks a 3810 non-cash when it can', () => {
    const warnings: ValidationResult[] = [];
    const out = withFringe([salary, { component: comp('3810'), amount: 3000 }], [vehicle], comp('3802'), period, warnings);
    expect(warnings).toEqual([]);
    expect(out.map((c) => [c.component.sarsSourceCode, c.isNonCash === true])).toEqual([['3601', false], ['3810', true], ['3802', true]]);
  });
});

describe('the loan preview and the stored line share one component list', () => {
  const loanComponents = { deduction: comp('LOAN', { componentType: 'deduction', isTaxable: false }), fringe: comp('3801') };
  const loan: ApplyLoanResult = {
    loanId: 'l', loanNumber: 'L1', employeeId: 'e1', scheduleRowId: 's', interest: 0, principal: 1000, installment: 1000, fringeBenefit: 200, openingBalance: 5000, closingBalance: 4000,
  };
  it('a vehicle plus a due loan: the preview basis gives the stored line\'s net, and its taxable equals the stored taxable', () => {
    const basis = { employee, components: withFringe([salary], [vehicle], comp('3802'), period, []) };
    const judged = judgeLoanApplications({ basis, applications: [loan], loanComponents, period, taxYear: 2027 });
    const stored = calculatePayrollLine({
      employee, components: appendLoanComponents(basis.components, [loan], loanComponents), period, taxYear: 2027, annualPayrollEstimate: 'defer',
    });
    const benefitOnly = calculatePayrollLine({
      employee, components: appendLoanComponents(basis.components, [{ ...loan, installment: 0, interest: 0, principal: 0 }], loanComponents),
      period, taxYear: 2027, annualPayrollEstimate: 'defer',
    });
    expect(judged.allowed).toBe(true);
    expect(judged.rawNet).toBe(stored.netPay);
    expect(benefitOnly.periodicTaxable).toBe(stored.periodicTaxable);
    // 40 000 + 80% of the 14 000 vehicle benefit + the 200 loan benefit
    expect(stored.periodicTaxable).toBe(51400);
  });
});
