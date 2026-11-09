/**
 * The calculator with fringe benefits (wave 5 FB). Sources: PAYE-GEN-01-G21 (2027) Rev 1 p. 5 (travel allowance
 * 80% / 20%; vehicle 3.5% / 3.25%) and p. 11-12 (an employer's medical contribution, code 3810, is a taxable
 * fringe benefit deemed paid by the employee, added to the 4005 contributions for the medical credits).
 */
import { describe, expect, it } from 'vitest';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import { applyFringeBenefits, effectiveInclusionRate } from '@/modules/accounting/services/payroll/fringeBenefits';
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

describe('SDL and ETI read the Fourth Schedule para 1 remuneration (SDL Act s3): a 3701 / 3802 at its PAYE share', () => {
  const sdlOn = (code: string): PayrollComponent => comp(code, { isSdlApplicable: true });
  it('R40 000 + a vehicle of 13 000 taxed at 20%: SDL is 1% of 42 600 = 426.00', () => {
    const benefit = { id: 'b', kind: 'company_vehicle' as const, determinedValue: 400000, maintenancePlan: true, businessUseAtLeast80: true, effectiveFrom: '2026-01-01', effectiveTo: null };
    const r = cost(applyFringeBenefits([salary(40000)], [benefit], sdlOn('3802'), { year: 2026, month: 3 }));
    expect(r.sdl).toBe(426);
  });
  it('R30 000 + a 3701 of 5 000 at 80%: SDL is 1% of 34 000 = 340.00', () => {
    expect(cost([salary(30000), { component: sdlOn('3701'), amount: 5000 }]).sdl).toBe(340);
  });
  it('UIF takes the same share (UIF Contributions Act s1, remuneration as the Fourth Schedule para 1): R10 000 + a 3701 of 5 000 is UIF on 14 000', () => {
    const r = cost([salary(10000), { component: comp('3701', { isUifApplicable: true }), amount: 5000 }]);
    expect(r.uif.employeeContribution).toBe(140);
  });
  it('a non-taxable 3701 has no share: SDL and UIF stay on the whole 5 000 and the breakdown stores no rate', () => {
    const r = cost([salary(30000), { component: comp('3701', { isTaxable: false, isSdlApplicable: true, isUifApplicable: true }), amount: 5000 }]);
    expect(r.sdl).toBe(300 + 50);
    expect(r.uif.employeeContribution).toBe(177.12);
    expect(r.componentBreakdown.find((b) => b.sarsSourceCode === '3701')).not.toHaveProperty('payeInclusionRate');
  });
});

describe('the breakdown keeps the exact PAYE share for the certificate (4582)', () => {
  it('stores rate and included amount; a non-taxable 3701 stores no included amount', () => {
    const r = cost([salary(30000), { component: comp('3701'), amount: 5000.55 }]);
    expect(r.componentBreakdown.find((b) => b.sarsSourceCode === '3701')).toMatchObject({ payeInclusionRate: 0.8, payeIncludedAmount: 4000.44 });
    const nt = cost([salary(30000), { component: comp('3701', { isTaxable: false }), amount: 5000 }]);
    expect(nt.componentBreakdown.find((b) => b.sarsSourceCode === '3701')).not.toHaveProperty('payeIncludedAmount');
  });
});

describe('one source for the 3701 default', () => {
  it('applyFringeBenefits with a default record and the calculator with no record use the same rate', () => {
    const travel = { id: 't', kind: 'travel_allowance' as const, determinedValue: null, maintenancePlan: false, businessUseAtLeast80: false, effectiveFrom: '2026-01-01', effectiveTo: null };
    const out = applyFringeBenefits([{ component: comp('3701'), amount: 5000 }], [travel], null, { year: 2026, month: 3 });
    expect(out[0]?.payeInclusionRate).toBe(effectiveInclusionRate('3701', undefined));
    expect(effectiveInclusionRate('3601', undefined)).toBeUndefined();
    expect(effectiveInclusionRate('3701', 0.2)).toBe(0.2);
  });
});

describe('3810 edge cases (review M2a, M2b, L3)', () => {
  const er = (n: number, over: Partial<PayrollComponent> = {}): EmployeeComponent => ({ component: comp('3810', over), amount: n });
  const fee4005 = (n: number): EmployeeComponent => ({ component: comp('4005', { componentType: 'deduction', isTaxable: false }), amount: n });
  const old = new Date(1955, 0, 1);

  it('a non-taxable 3810 is not deemed paid and the line carries a blocking error (65+ credit stays nil)', () => {
    const r = cost(markNonCashEmployerBenefits([salary(25000), er(6000, { isTaxable: false })]), old);
    expect(r.medicalSchemeFees).toBe(0);
    expect(r.additionalMedicalCredit).toBe(0);
    expect(r.validationResults.find((v) => v.code === 'MEDICAL_BENEFIT_NOT_TAXABLE')).toMatchObject({ severity: 'error' });
  });
  it('the default is the split: R25 000 + a 3810 of 2 000 + a 4005 of 2 000 is non-cash, fees 4 000, net excludes the 2 000', () => {
    const marked = markNonCashEmployerBenefits([salary(25000), er(2000), fee4005(2000)]);
    expect(marked[1]?.isNonCash).toBe(true);
    const r = cost(marked, old);
    expect(r.medicalSchemeFees).toBe(4000);
    expect(r.grossPay).toBe(25000);
    expect(r.netPay).toBe(Math.round((25000 - 2000 - r.paye.monthlyPaye - r.uif.employeeContribution) * 100) / 100);
    expect(r.validationResults.find((v) => v.code === 'MEDICAL_SPLIT_ASSUMED')).toMatchObject({ severity: 'info' });
    expect(r.validationResults.some((v) => v.code === 'MEDICAL_GROSS_UP_PATTERN')).toBe(false);
  });
  it('the explicit medical_gross_up opt-in keeps the 3810 as cash and counts the fees once', () => {
    const gross = { id: 'g', kind: 'medical_gross_up' as const, determinedValue: null, maintenancePlan: false, businessUseAtLeast80: false, effectiveFrom: '2026-01-01', effectiveTo: null };
    const out = applyFringeBenefits([salary(25000), er(2000), fee4005(2000)], [gross], null, { year: 2026, month: 3 });
    expect(out[1]).not.toHaveProperty('isNonCash');
    const r = cost(out, old);
    expect(r.medicalSchemeFees).toBe(2000);
    expect(r.grossPay).toBe(27000);
    expect(r.validationResults.find((v) => v.code === 'MEDICAL_GROSS_UP_PATTERN')).toMatchObject({ severity: 'info' });
    expect(r.validationResults.some((v) => v.code === 'MEDICAL_SPLIT_ASSUMED')).toBe(false);
  });
  it('a 3810 for an employee with no medical membership warns that no credit was given', () => {
    const e = { ...employee(new Date(1986, 0, 1)), medicalAidMainMember: false };
    const r = calculatePayrollLine({ employee: e, components: markNonCashEmployerBenefits([salary(25000), er(3000)]), period: { year: 2026, month: 3 }, taxYear: 2027, annualPayrollEstimate: 1_000_000 });
    expect(r.validationResults.find((v) => v.code === 'MEDICAL_BENEFIT_WITHOUT_MEMBERSHIP')).toMatchObject({ severity: 'warning' });
  });
  it('a 3810-only employee with no medical membership gets no "4005 is deducted" warning', () => {
    const e = { ...employee(new Date(1986, 0, 1)), medicalAidMainMember: false };
    const r = calculatePayrollLine({ employee: e, components: markNonCashEmployerBenefits([salary(25000), er(3000)]), period: { year: 2026, month: 3 }, taxYear: 2027, annualPayrollEstimate: 1_000_000 });
    expect(r.validationResults.some((v) => v.code === 'MEDICAL_FEES_WITHOUT_MEMBERSHIP')).toBe(false);
  });
  it('a deducted 4005 with no membership still warns, for the deducted amount only', () => {
    const e = { ...employee(new Date(1986, 0, 1)), medicalAidMainMember: false };
    const r = calculatePayrollLine({ employee: e, components: markNonCashEmployerBenefits([salary(25000), er(3000), fee4005(500)]), period: { year: 2026, month: 3 }, taxYear: 2027, annualPayrollEstimate: 1_000_000 });
    expect(r.validationResults.some((v) => v.code === 'MEDICAL_FEES_WITHOUT_MEMBERSHIP')).toBe(true);
  });
});

describe('a hand-assigned 3802 (review L1)', () => {
  it('is taxed in full as cash and says so (FRINGE_RECORD_MISSING); no figure change', () => {
    const r = cost([salary(40000), { component: comp('3802'), amount: 14000 }]);
    expect(r.periodicTaxable).toBe(54000);
    expect(r.validationResults.find((v) => v.code === 'FRINGE_RECORD_MISSING')).toMatchObject({ severity: 'warning' });
  });
  it('an injected, non-cash 3802 does not warn', () => {
    const b = { id: 'b', kind: 'company_vehicle' as const, determinedValue: 400000, maintenancePlan: false, businessUseAtLeast80: false, effectiveFrom: '2026-01-01', effectiveTo: null };
    const r = cost(applyFringeBenefits([salary(40000)], [b], comp('3802'), { year: 2026, month: 3 }));
    expect(r.validationResults.some((v) => v.code === 'FRINGE_RECORD_MISSING')).toBe(false);
  });
});
