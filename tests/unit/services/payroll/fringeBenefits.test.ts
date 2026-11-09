/**
 * Pure fringe-benefit rules (wave 5 FB). Sources: PAYE-GEN-01-G21 (2027) Rev 1 p. 5 (travel 80/20, vehicle 3.5% /
 * 3.25%); BRS V25.3.0 code 4582 p. 105 (80 or 20% of 3802 is remuneration); Seventh Schedule para 7.
 */
import { describe, expect, it } from 'vitest';
import {
  applyFringeBenefits,
  FringeBenefitConfigError,
  benefitActiveInPeriod,
  includedInPaye,
  payeInclusionRate,
  vehicleMonthlyBenefit,
  type FringeBenefit,
} from '@/modules/accounting/services/payroll/fringeBenefits';
import type { EmployeeComponent, PayrollComponent } from '@/modules/accounting/services/payroll/payrollTypes';

const earning = (code: string, over: Partial<PayrollComponent> = {}): PayrollComponent => ({
  id: `c-${code}`, name: `Earning ${code}`, sarsSourceCode: code, componentType: 'earning',
  isTaxable: true, isUifApplicable: false, isSdlApplicable: false, ...over,
});
const vehicle = (over: Partial<FringeBenefit> = {}): FringeBenefit => ({
  id: 'b1', kind: 'company_vehicle', determinedValue: 400000, maintenancePlan: false, businessUseAtLeast80: false,
  effectiveFrom: '2026-01-01', effectiveTo: null, ...over,
});
const travel = (over: Partial<FringeBenefit> = {}): FringeBenefit => ({
  id: 'b2', kind: 'travel_allowance', determinedValue: null, maintenancePlan: false, businessUseAtLeast80: false,
  effectiveFrom: '2026-01-01', effectiveTo: null, ...over,
});

describe('vehicleMonthlyBenefit [G21 p. 5; Seventh Schedule para 7]', () => {
  it('3.5% of the determined value a month', () => expect(vehicleMonthlyBenefit(400000, false)).toBe(14000));
  it('3.25% with a maintenance plan in the purchase price', () => expect(vehicleMonthlyBenefit(400000, true)).toBe(13000));
  it('rounds to the cent', () => expect(vehicleMonthlyBenefit(123456.78, false)).toBe(4320.99));
});

describe('payeInclusionRate [G21 p. 5; BRS code 4582 p. 105]', () => {
  it('80% by default', () => expect(payeInclusionRate(false)).toBe(0.8));
  it('20% where the employer is satisfied business use is at least 80%', () => expect(payeInclusionRate(true)).toBe(0.2));
  it('includedInPaye is the rounded share', () => {
    expect(includedInPaye(14000, 0.8)).toBe(11200);
    expect(includedInPaye(13333.33, 0.8)).toBe(10666.66);
  });
});

describe('benefitActiveInPeriod', () => {
  it('is active in every month it touches', () => {
    const b = vehicle({ effectiveFrom: '2026-03-15', effectiveTo: '2026-05-10' });
    expect(benefitActiveInPeriod(b, { year: 2026, month: 2 })).toBe(false);
    expect(benefitActiveInPeriod(b, { year: 2026, month: 3 })).toBe(true);
    expect(benefitActiveInPeriod(b, { year: 2026, month: 5 })).toBe(true);
    expect(benefitActiveInPeriod(b, { year: 2026, month: 6 })).toBe(false);
  });
  it('an open row has no end', () => expect(benefitActiveInPeriod(vehicle(), { year: 2030, month: 12 })).toBe(true));
});

describe('applyFringeBenefits', () => {
  const period = { year: 2026, month: 3 };
  const base: EmployeeComponent[] = [{ component: earning('3601', { isUifApplicable: true }), amount: 40000 }];

  it('injects a non-cash 3802 at the monthly benefit with the 80% PAYE rate', () => {
    const out = applyFringeBenefits(base, [vehicle()], earning('3802'), period);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ amount: 14000, isNonCash: true, payeInclusionRate: 0.8 });
    expect(out[1]?.component.sarsSourceCode).toBe('3802');
  });
  it('maintenance plan and 80% business use: 13 000 at the 20% rate', () => {
    const out = applyFringeBenefits(base, [vehicle({ maintenancePlan: true, businessUseAtLeast80: true })], earning('3802'), period);
    expect(out[1]).toMatchObject({ amount: 13000, isNonCash: true, payeInclusionRate: 0.2 });
  });
  it('a vehicle record with no 3802 earning component is refused, never silently dropped', () => {
    expect(() => applyFringeBenefits(base, [vehicle()], null, period)).toThrow(FringeBenefitConfigError);
  });
  it('an assigned 3802 earning beside a vehicle record is refused (double-counted otherwise)', () => {
    const both: EmployeeComponent[] = [...base, { component: earning('3802'), amount: 14000 }];
    expect(() => applyFringeBenefits(both, [vehicle()], earning('3802'), period)).toThrow(/already/);
  });
  it('travel 3701 takes 80% by default and 20% with the business-use flag', () => {
    const withTravel: EmployeeComponent[] = [...base, { component: earning('3701'), amount: 5000 }];
    expect(applyFringeBenefits(withTravel, [travel()], null, period)[1]?.payeInclusionRate).toBe(0.8);
    expect(applyFringeBenefits(withTravel, [travel({ businessUseAtLeast80: true })], null, period)[1]?.payeInclusionRate).toBe(0.2);
  });
  it('a benefit outside the period changes nothing', () => {
    const out = applyFringeBenefits(base, [vehicle({ effectiveTo: '2026-02-28' })], earning('3802'), period);
    expect(out).toEqual(base);
  });
  it('does not mutate its input', () => {
    const withTravel: EmployeeComponent[] = [...base, { component: earning('3701'), amount: 5000 }];
    applyFringeBenefits(withTravel, [travel()], null, period);
    expect(withTravel[1]).not.toHaveProperty('payeInclusionRate');
  });
});
