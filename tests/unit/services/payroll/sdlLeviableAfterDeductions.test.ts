/**
 * SDL is levied on the BALANCE of remuneration: SDL-applicable remuneration
 * less the paragraph 2(4) Fourth Schedule deductions the PAYE calculation
 * allows (pension, provident, RAF), never below nil.
 *
 * Sources: SARS SDL-GEN-01-G01 Rev 5 s6; PAYE-GEN-01-G21 (2027 tax year)
 * 'SDL liable amount'; SDL Act s3(4).
 *
 * The para 2(4) figure is the one the PAYE path computes (deduction components
 * flagged taxable), not a second limit. IsaFlow does not apply the s11F cap and
 * does not model employer retirement contributions as a fringe benefit /
 * deemed employee contribution — for PAYE or for SDL — so these tests pin that
 * SDL follows PAYE in both of those cases rather than diverging from it.
 */
import { describe, it, expect } from 'vitest';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import { applySdlToLines } from '@/modules/accounting/services/payroll/sdlLeviabilityService';
import type { EmployeeComponent, PayrollComponent, PayrollLineInput } from '@/modules/accounting/services/payroll/payrollTypes';

function comp(code: string, extra: Partial<PayrollComponent> = {}): PayrollComponent {
  return {
    id: `c-${code}`, name: code, sarsSourceCode: code, componentType: 'earning',
    isTaxable: true, isUifApplicable: true, isSdlApplicable: true, ...extra,
  };
}

const salary = (amount: number): EmployeeComponent => ({ component: comp('3601'), amount });
const pension = (amount: number): EmployeeComponent => ({
  component: comp('4001', { componentType: 'deduction', isUifApplicable: false, isSdlApplicable: false }), amount,
});
const ra = (amount: number): EmployeeComponent => ({
  component: comp('4006', { componentType: 'deduction', isUifApplicable: false, isSdlApplicable: false }), amount,
});

function line(components: EmployeeComponent[], annualPayrollEstimate: number | 'defer' = 1_000_000) {
  const input: PayrollLineInput = {
    employee: {
      id: 'emp-1', companyId: 'co-1', employeeNumber: 'E1', firstName: 'A', lastName: 'B',
      idNumber: '9001015009087', taxNumber: '1234567890', employmentType: 'permanent',
      startDate: new Date('2020-01-01'), dateOfBirth: new Date('1990-01-01'),
      uifExcluded: false, medicalAidMainMember: false, medicalAidDependantsCount: 0,
    },
    components,
    period: { month: 6, year: 2026 },
    taxYear: 2027,
    annualPayrollEstimate,
  };
  return calculatePayrollLine(input);
}

describe('SDL leviable amount after para 2(4) deductions (SARS SDL-GEN-01-G01 Rev 5 s6; PAYE-GEN-01-G21 (2027 tax year) \'SDL liable amount\'; SDL Act s3(4))', () => {
  it('zero-deduction case is unchanged: leviable = SDL-applicable remuneration', () => {
    const r = line([salary(30_000)]);
    expect(r.sdlLeviable).toBe(30_000);
    expect(r.sdl).toBe(300);
  });

  it('pension fund contribution (4001) comes off the leviable amount', () => {
    const r = line([salary(30_000), pension(2_250)]);
    expect(r.taxableIncome).toBe(27_750);
    expect(r.sdlLeviable).toBe(27_750);
    expect(r.sdl).toBe(277.5);
  });

  it('retirement annuity contribution (4006) comes off the leviable amount', () => {
    const r = line([salary(40_000), ra(3_000)]);
    expect(r.sdlLeviable).toBe(37_000);
    expect(r.sdl).toBe(370);
  });

  it('uses exactly the PAYE para 2(4) figure: a deduction not allowed for PAYE (not flagged taxable) is not deducted', () => {
    const notDeductible: EmployeeComponent = {
      component: comp('4001', { componentType: 'deduction', isTaxable: false, isUifApplicable: false, isSdlApplicable: false }),
      amount: 2_250,
    };
    const r = line([salary(30_000), notDeductible]);
    expect(r.taxableIncome).toBe(30_000);
    expect(r.sdlLeviable).toBe(30_000);
  });

  it('s11F cap: no second limit — SDL deducts what PAYE deducts, even above 27.5% (cap not modelled for PAYE either)', () => {
    // 40% of remuneration: above the s11F 27.5% limit. PAYE allows it in full
    // (named limit, see payrollCalculator), so SDL must too, or the two
    // "balance of remuneration" figures would disagree.
    const r = line([salary(20_000), ra(8_000)]);
    const payeDeduction = 20_000 - r.taxableIncome;
    expect(payeDeduction).toBe(8_000);
    expect(r.sdlLeviable).toBe(20_000 - payeDeduction);
  });

  it('employer retirement contribution: neither added as fringe benefit nor deducted, for PAYE or SDL', () => {
    const employerContribution: EmployeeComponent = {
      component: comp('4474', { componentType: 'employer_contribution' }), amount: 2_000,
    };
    const base = line([salary(30_000), pension(2_250)]);
    const r = line([salary(30_000), pension(2_250), employerContribution]);
    expect(r.taxableIncome).toBe(base.taxableIncome);
    expect(r.sdlLeviable).toBe(base.sdlLeviable);
  });

  it('SDL exclusions still apply, and the leviable amount never goes below nil', () => {
    // R5 000 SDL-applicable + R10 000 taxable but SDL-excluded; RA R8 000 is
    // allowed for PAYE in full against the R15 000 taxable remuneration.
    const sdlExcluded: EmployeeComponent = { component: comp('3713', { isSdlApplicable: false }), amount: 10_000 };
    const r = line([salary(5_000), sdlExcluded, ra(8_000)]);
    expect(r.taxableIncome).toBe(7_000);
    expect(r.sdlLeviable).toBe(0);
    expect(r.sdl).toBe(0);
  });

  it('deductions above taxable remuneration leave a nil leviable amount, not a negative one', () => {
    const r = line([salary(3_000), ra(5_000)]);
    expect(r.sdlLeviable).toBe(0);
    expect(r.sdl).toBe(0);
  });
});

describe('SDL exemption threshold with deductions (SARS SDL-GEN-01-G01 Rev 5 s6; PAYE-GEN-01-G21 (2027 tax year) \'SDL liable amount\'; SDL Act s3(4))', () => {
  it('an exempt employer (estimate <= R500 000) pays nil whatever the deductions', () => {
    expect(line([salary(30_000), pension(2_250)], 500_000).sdl).toBe(0);
  });

  it('a liable employer pays 1% of the leviable amount after deductions', () => {
    expect(line([salary(30_000), pension(2_250)], 500_001).sdl).toBe(277.5);
  });

  it('the run pass charges each line on its after-deduction leviable amount once the threshold is crossed', () => {
    const deferred = line([salary(30_000), pension(2_250)], 'defer');
    expect(deferred.sdl).toBe(0);
    const lines = [{ sdl: 0, sdlLeviable: deferred.sdlLeviable }];
    expect(applySdlToLines(lines, 600_000, 2027)).toBe(277.5);
    expect(applySdlToLines([{ sdl: 0, sdlLeviable: deferred.sdlLeviable }], 480_000, 2027)).toBe(0);
  });
});
