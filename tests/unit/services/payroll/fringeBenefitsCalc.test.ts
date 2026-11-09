/**
 * The calculator with fringe benefits (wave 5 FB). Sources: PAYE-GEN-01-G21 (2027) Rev 1 p. 5 (travel allowance
 * 80% / 20%; vehicle 3.5% / 3.25%) and p. 11-12 (an employer's medical contribution, code 3810, is a taxable
 * fringe benefit deemed paid by the employee, added to the 4005 contributions for the medical credits).
 */
import { describe, expect, it } from 'vitest';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import { applyFringeBenefits } from '@/modules/accounting/services/payroll/fringeBenefits';
import { markNonCashEmployerBenefits } from '@/modules/accounting/services/payroll/employerContributions';
import type { EmployeeComponent, PayrollComponent, PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';

const comp = (code: string, over: Partial<PayrollComponent> = {}): PayrollComponent => ({
  id: `c-${code}`, name: code, sarsSourceCode: code, componentType: 'earning',
  isTaxable: true, isUifApplicable: false, isSdlApplicable: false, ...over,
});
const employee = (dob: Date): PayrollEmployee => ({
  id: 'e1', companyId: 'c1', employeeNumber: '1', firstName: 'A', lastName: 'B', employmentType: 'permanent',
  startDate: new Date(2020, 0, 1), dateOfBirth: dob, uifExcluded: false, medicalAidMainMember: true,
  medicalAidDependantsCount: 0, s18aReceiptHeld: false,
});
const cost = (components: EmployeeComponent[], dob = new Date(1986, 0, 1)) =>
  calculatePayrollLine({ employee: employee(dob), components, period: { year: 2026, month: 3 }, taxYear: 2027, annualPayrollEstimate: 1_000_000 });
const salary = (n: number): EmployeeComponent => ({ component: comp('3601', { isUifApplicable: true, isSdlApplicable: true }), amount: n });

describe('travel allowance 3701 [G21 p. 5]', () => {
  const travel: EmployeeComponent = { component: comp('3701'), amount: 5000 };
  it('is taxed at 80% with no record at all (every existing 3701 earning)', () => {
    const r = cost([salary(30000), travel]);
    expect(r.periodicTaxable).toBe(34000);
    expect(r.grossPay).toBe(35000);
    expect(r.componentBreakdown.find((b) => b.sarsSourceCode === '3701')).toMatchObject({ amount: 5000, payeInclusionRate: 0.8 });
  });
  it('is taxed at 20% where the business use is at least 80%', () => {
    const r = cost([salary(30000), { ...travel, payeInclusionRate: 0.2 }]);
    expect(r.periodicTaxable).toBe(31000);
    expect(r.grossPay).toBe(35000);
  });
});

describe('company vehicle 3802 [G21 p. 5; BRS code 4582 p. 105]', () => {
  const benefit = { id: 'b', kind: 'company_vehicle' as const, determinedValue: 400000, maintenancePlan: false, businessUseAtLeast80: false, effectiveFrom: '2026-01-01', effectiveTo: null };
  it('is non-cash: 80% taxed, the full 14 000 in the breakdown, none of it in gross or net pay', () => {
    const r = cost(applyFringeBenefits([salary(40000)], [benefit], comp('3802'), { year: 2026, month: 3 }));
    expect(r.periodicTaxable).toBe(51200);
    expect(r.grossPay).toBe(40000);
    expect(r.remuneration).toBe(54000);
    expect(r.componentBreakdown.find((b) => b.sarsSourceCode === '3802')).toMatchObject({ amount: 14000, isNonCash: true, payeInclusionRate: 0.8 });
  });
  it('maintenance plan and business use: 13 000 at 20%', () => {
    const r = cost(applyFringeBenefits([salary(40000)], [{ ...benefit, maintenancePlan: true, businessUseAtLeast80: true }], comp('3802'), { year: 2026, month: 3 }));
    expect(r.periodicTaxable).toBe(42600);
  });
});

describe('employer medical contribution 3810 [G21 p. 11-12; Seventh Schedule para 12A]', () => {
  const er = (n: number): EmployeeComponent => ({ component: comp('3810'), amount: n });
  it('is non-cash: taxed in full, but not in gross or net pay', () => {
    const r = cost(markNonCashEmployerBenefits([salary(25000), er(3000)]));
    expect(r.periodicTaxable).toBe(28000);
    expect(r.grossPay).toBe(25000);
    expect(r.remuneration).toBe(28000);
    expect(r.componentBreakdown.find((b) => b.sarsSourceCode === '3810')?.isNonCash).toBe(true);
    // PAYE on the benefit comes out of the cash: net = cash gross - PAYE - UIF.
    expect(r.netPay).toBe(Math.round((25000 - r.paye.monthlyPaye - r.uif.employeeContribution) * 100) / 100);
  });
  it('counts as fees deemed paid by the employee: the 65+ additional credit equals the 4005 equivalent', () => {
    const old = new Date(1955, 0, 1);
    const viaEmployer = cost(markNonCashEmployerBenefits([salary(25000), er(6000)]), old);
    const viaDeduction = cost([salary(25000), { component: comp('4005', { componentType: 'deduction', isTaxable: false }), amount: 6000 }], old);
    const none = cost([salary(25000)], old);
    expect(viaDeduction.additionalMedicalCredit).toBeGreaterThan(0);
    expect(viaEmployer.medicalSchemeFees).toBe(6000);
    expect(viaEmployer.additionalMedicalCredit).toBe(viaDeduction.additionalMedicalCredit);
    expect(none.additionalMedicalCredit).toBe(0);
  });
});
