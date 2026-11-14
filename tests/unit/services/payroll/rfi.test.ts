/**
 * Retirement-funding income (wave 5 RF, rfi.ts). RFI is the fund's contribution base: the earnings flagged counts_as_rfi.
 * A percent_of_rfi assignment costs round2(pct x RFI). RFI is never a tax limit (PAYE-GEN-01-G21 (2027) Rev 1 p. 10:
 * s11F is 27.5% of the higher of remuneration or taxable income); that half is pinned in employerRetirementCalc.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { costPercentOfRfi, percentOfRfiRefusal, retirementFundingIncome } from '@/modules/accounting/services/payroll/rfi';
import type { EmployeeComponent, PayrollComponent } from '@/modules/accounting/services/payroll/payrollTypes';

const comp = (code: string, over: Partial<PayrollComponent> = {}): PayrollComponent => ({
  id: `c-${code}`, name: `Code ${code}`, sarsSourceCode: code, componentType: 'earning',
  isTaxable: true, isUifApplicable: true, isSdlApplicable: true, ...over,
});
const salary = (n: number): EmployeeComponent => ({ component: comp('3601', { countsAsRfi: true }), amount: n });
const commission = (n: number): EmployeeComponent => ({ component: comp('3606'), amount: n });
const erPension = (pct: number): EmployeeComponent => ({ component: comp('3817'), amount: 0, percentOfRfi: pct });
const eePension = (pct: number): EmployeeComponent => ({ component: comp('4001', { componentType: 'deduction' }), amount: 0, percentOfRfi: pct });

describe('retirementFundingIncome', () => {
  it('is the sum of the earnings flagged counts_as_rfi only', () => {
    expect(retirementFundingIncome([salary(20_000), commission(10_000)])).toBe(20_000);
  });
  it('takes in a second flagged earning', () => {
    const flaggedCommission: EmployeeComponent = { component: comp('3606', { countsAsRfi: true }), amount: 5_000.5 };
    expect(retirementFundingIncome([salary(20_000), flaggedCommission])).toBe(25_000.5);
  });
  it('never counts a deduction, nor a percent_of_rfi row itself (no circular base)', () => {
    const flaggedDeduction: EmployeeComponent = { component: comp('4001', { componentType: 'deduction', countsAsRfi: true }), amount: 900 };
    const flaggedPercent: EmployeeComponent = { component: comp('3817', { countsAsRfi: true }), amount: 0, percentOfRfi: 0.1 };
    expect(retirementFundingIncome([salary(20_000), flaggedDeduction, flaggedPercent])).toBe(20_000);
  });
});

describe('costPercentOfRfi', () => {
  it('costs each percent_of_rfi row at round2(pct x RFI) and records the base', () => {
    const { components, rfi, warnings } = costPercentOfRfi([salary(20_000), commission(10_000), erPension(0.15), eePension(0.075)]);
    expect(rfi).toBe(20_000);
    expect(components.find((c) => c.component.sarsSourceCode === '3817')).toMatchObject({ amount: 3_000, rfiBase: 20_000, percentOfRfi: 0.15 });
    expect(components.find((c) => c.component.sarsSourceCode === '4001')).toMatchObject({ amount: 1_500, rfiBase: 20_000 });
    expect(warnings).toEqual([]);
  });
  it('rounds to the cent', () => {
    const { components } = costPercentOfRfi([salary(12_345.67), erPension(0.0725)]);
    expect(components[1]!.amount).toBe(895.06);
  });
  it('leaves plain amounts alone and does not mutate its input', () => {
    const input = [salary(20_000), { ...erPension(0.1), percentOfRfi: null, amount: 777 }];
    const { components } = costPercentOfRfi(input);
    expect(components[1]!.amount).toBe(777);
    expect(input[1]!.amount).toBe(777);
    const pct = [salary(20_000), erPension(0.1)];
    costPercentOfRfi(pct);
    expect(pct[1]!.amount).toBe(0);
  });
  it('warns when a percent row has no RFI to cost on (nothing flagged)', () => {
    const { components, warnings } = costPercentOfRfi([commission(10_000), erPension(0.15)]);
    expect(components[1]!.amount).toBe(0);
    expect(warnings.map((w) => [w.code, w.severity])).toEqual([['RFI_NIL', 'warning']]);
    expect(warnings[0]!.message).toContain('Code 3817');
  });
});

describe('percentOfRfiRefusal', () => {
  it('allows a retirement contribution deduction (4001 / 4003 / 4006) and an employer fund benefit earning (3817 / 3825 / 3828)', () => {
    for (const code of ['4001', '4003', '4006']) expect(percentOfRfiRefusal('deduction', code), code).toBeNull();
    for (const code of ['3817', '3825', '3828', ' 3817 ']) expect(percentOfRfiRefusal('earning', code), code).toBeNull();
  });
  it('refuses anything else, and the wrong type for a code', () => {
    for (const [type, code] of [['earning', '3601'], ['deduction', '4005'], ['earning', '4001'], ['deduction', '3817']] as const) {
      expect(percentOfRfiRefusal(type, code), `${type} ${code}`).toMatch(/percentage of retirement-funding income/);
    }
  });
});
