/**
 * SDL is levied on the BALANCE of remuneration: SDL-applicable remuneration
 * less the paragraph 2(4) Fourth Schedule deductions, never below nil.
 *
 * Sources: SARS SDL-GEN-01-G01 Rev 5 s6; PAYE-GEN-01-G21 (2027 tax year)
 * 'SDL liable amount'; SDL Act s3(4); PAYE-GEN-01-G21 (2027) Rev 1 s7.3.1;
 * PAYE-GEN-01-G20 (2026) s7.3.1.
 *
 * The only deduction that reduces SDL is the retirement fund contribution
 * (4001/4003/4006), by the s11F figure PAYE 4c already records on the line
 * (`retirementDeduction`: cumulative over the tax year, capped by 27.5% and
 * `TaxYearConfig.retirementDeductionCap`). SDL applies it to the year, not the
 * line (sdlLeviableCumulative): leviable to date = max(0, SDL-applicable pay to
 * date - deduction to date), a line takes the rise. Every other taxable
 * deduction reduces PAYE only. Donations (4030) do not reduce SDL: payroll models no s18A
 * receipt or approved organisation.
 */
import { describe, it, expect } from 'vitest';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import { applySdlToLines } from '@/modules/accounting/services/payroll/sdlLeviabilityService';
import { sdlYearToDate, type SdlYearToDateLine } from '@/modules/accounting/services/payroll/payrollSdlYearToDate';
import type {
  EmployeeComponent, PayeYearToDate, PayrollComponent, PayrollLineInput, PayrollLineResult,
} from '@/modules/accounting/services/payroll/payrollTypes';

function comp(code: string, extra: Partial<PayrollComponent> = {}): PayrollComponent {
  return {
    id: `c-${code}`, name: code, sarsSourceCode: code, componentType: 'earning',
    isTaxable: true, isUifApplicable: true, isSdlApplicable: true, ...extra,
  };
}

const deduction = (code: string, amount: number, extra: Partial<PayrollComponent> = {}): EmployeeComponent => ({
  component: comp(code, { componentType: 'deduction', isUifApplicable: false, isSdlApplicable: false, ...extra }), amount,
});
const salary = (amount: number): EmployeeComponent => ({ component: comp('3601'), amount });
const pension = (amount: number): EmployeeComponent => deduction('4001', amount);
const ra = (amount: number): EmployeeComponent => deduction('4006', amount);
const donation = (amount: number): EmployeeComponent => deduction('4030', amount);
// 4018 = Union dues; isTaxable defaults to true.
const unionFees = (amount: number): EmployeeComponent => deduction('4018', amount);

const employee: PayrollLineInput['employee'] = {
  id: 'emp-1', companyId: 'co-1', employeeNumber: 'E1', firstName: 'A', lastName: 'B',
  idNumber: '9001015009087', taxNumber: '1234567890', employmentType: 'permanent',
  startDate: new Date('2020-01-01'), dateOfBirth: new Date('1990-01-01'),
  uifExcluded: false, medicalAidMainMember: false, medicalAidDependantsCount: 0,
};

function line(
  components: EmployeeComponent[],
  annualPayrollEstimate: number | 'defer' = 1_000_000,
  extra: Partial<PayrollLineInput> = {},
) {
  return calculatePayrollLine({
    employee, components, period: { month: 6, year: 2026 }, taxYear: 2027, annualPayrollEstimate, ...extra,
  });
}

const ytdOf = (extra: Partial<PayeYearToDate>): PayeYearToDate => ({
  periods: 0, periodicTaxable: 0, annualPayments: 0, tablePaye: 0,
  medicalCredit: 0, additionalMedicalCredit: 0, medicalSchemeFees: 0, ...extra,
});

const r2 = (n: number): number => Math.round(n * 100) / 100;
const sdlPay = (cs: EmployeeComponent[]): number =>
  cs.filter(c => c.component.componentType === 'earning' && c.component.isSdlApplicable).reduce((t, c) => t + c.amount, 0);

/**
 * A tax year month by month from April 2026, carrying the year to date as the run service and
 * loadPayeYearToDate do (SDL half: sdlYearToDate over the same lines). `withSdl: false` carries the
 * PAYE half only, to show the SDL fields never change a PAYE figure.
 */
function year(months: EmployeeComponent[][], withSdl = true): PayrollLineResult[] {
  const results: PayrollLineResult[] = [];
  const sdlLines: SdlYearToDateLine[] = [];
  let ytd: PayeYearToDate | undefined;
  months.forEach((components, i) => {
    const r = line(components, 1_000_000, { period: { month: 4 + i, year: 2026 }, ytd });
    results.push(r);
    sdlLines.push({ line: String(i), sdlApplicable: sdlPay(components), retirement: r.retirementDeduction });
    const prev = ytd ?? ytdOf({});
    ytd = {
      ...prev,
      periods: prev.periods + (r.periodicRemuneration > 0 ? 1 : 0),
      retirementCapPeriods: (prev.retirementCapPeriods ?? 0) + (r.periodicRemuneration > 0 || r.annualPaymentRemuneration > 0 ? 1 : 0),
      periodicTaxable: r2(prev.periodicTaxable + r.periodicTaxable),
      annualPayments: r2(prev.annualPayments + r.annualTaxable),
      tablePaye: r2(prev.tablePaye + r.paye.monthlyPaye),
      retirementContributions: r2((prev.retirementContributions ?? 0) + r.retirementContributions),
      retirementDeduction: r2((prev.retirementDeduction ?? 0) + r.retirementDeduction),
      ...(withSdl ? sdlYearToDate(sdlLines, {}) : {}),
    };
  });
  return results;
}
const totalSdl = (rs: PayrollLineResult[]): number => r2(rs.reduce((t, r) => t + r.sdl, 0));
const totalLeviable = (rs: PayrollLineResult[]): number => r2(rs.reduce((t, r) => t + r.sdlLeviable, 0));
const nonSdl = (code: string, amount: number): EmployeeComponent => ({ component: comp(code, { isSdlApplicable: false }), amount });

describe('SDL leviable amount after para 2(4) deductions (SARS SDL-GEN-01-G01 Rev 5 s6; PAYE-GEN-01-G21 (2027 tax year) \'SDL liable amount\'; SDL Act s3(4))', () => {
  it('zero-deduction case is unchanged: leviable = SDL-applicable remuneration', () => {
    const r = line([salary(30_000)]);
    expect(r.sdlLeviable).toBe(30_000);
    expect(r.sdl).toBe(300);
  });

  it('pension fund contribution (4001) comes off the leviable amount', () => {
    const r = line([salary(30_000), pension(2_250)]);
    expect(r.retirementDeduction).toBe(2_250);
    expect(r.sdlLeviable).toBe(27_750);
    expect(r.sdl).toBe(277.5);
  });

  it('retirement annuity contribution (4006) comes off the leviable amount', () => {
    const r = line([salary(40_000), ra(3_000)]);
    expect(r.sdlLeviable).toBe(37_000);
    expect(r.sdl).toBe(370);
  });

  it('provident fund contribution (4003) comes off the leviable amount', () => {
    const r = line([salary(40_000), deduction('4003', 3_000)]);
    expect(r.sdlLeviable).toBe(37_000);
  });

  it('recognises seeded retirement components even when isTaxable is false', () => {
    const seededPension = deduction('4001', 2_250, { isTaxable: false });
    const r = line([salary(30_000), seededPension]);
    expect(r.sdlLeviable).toBe(27_750);
  });

  it('a contribution paid outside payroll reduces SDL by the same figure it reduces PAYE', () => {
    const outside = deduction('4006', 3_000, { paidOutsidePayroll: true });
    const r = line([salary(40_000), outside]);
    expect(r.sdlLeviable).toBe(40_000 - r.retirementDeduction);
    expect(r.sdlLeviable).toBe(37_000);
  });

  it('s11F cap: R20 000 salary + R8 000 RA (40%) → SDL deducts R5 500 (27.5%), the figure PAYE records; SDL = R145', () => {
    // Sources: SARS PAYE-GEN-01-G21 (2027) Rev 1 s7.3.1; PAYE-GEN-01-G20 (2026) s7.3.1;
    //          SDL-GEN-01-G01 Rev 5 s6.
    // 27.5% × R20 000 = R5 500 < R430 000/12 = R35 833, so the percentage cap binds.
    const r = line([salary(20_000), ra(8_000)]);
    expect(r.retirementDeduction).toBe(5_500);
    expect(r.sdlLeviable).toBe(14_500);
    expect(r.sdl).toBe(145);
  });

  it('s11F annual-cap boundary (2027: R430 000/12 ≈ R35 833): cap binds above 27.5%', () => {
    // Sources: SARS PAYE-GEN-01-G21 (2027) Rev 1 s7.3.1; SDL-GEN-01-G01 Rev 5 s6.
    // Salary R200 000/month; 27.5% = R55 000 > R430 000/12, so the annual cap binds.
    const r = line([salary(200_000), ra(55_000)]);
    const expectedLeviable = 200_000 - 430_000 / 12;
    expect(r.sdlLeviable).toBeCloseTo(expectedLeviable, 2);
    expect(r.sdl).toBeCloseTo(expectedLeviable * 0.01, 2);
  });

  it('s11F annual-cap boundary — 2026 tax year (R350 000/12 ≈ R29 167)', () => {
    // Sources: SARS PAYE-GEN-01-G20 (2026) s7.3.1; SDL-GEN-01-G01 Rev 5 s6.
    const r = line([salary(200_000), ra(55_000)], 1_000_000, { period: { month: 6, year: 2025 }, taxYear: 2026 });
    expect(r.sdlLeviable).toBeCloseTo(200_000 - 350_000 / 12, 2);
    expect(r.sdl).toBeCloseTo((200_000 - 350_000 / 12) * 0.01, 2);
  });

  it('uses the remaining cumulative annual cap for a February catch-up contribution (PAYE-GEN-01-G21 (2027) Rev 1 s7.3.1)', () => {
    // Eleven months at R200 000 with R30 000 contributed each (R330 000 deducted); February adds R100 000.
    // Year: contributions R430 000 ≤ 27.5% × R2.4m and ≤ the R430 000 cap, so all R100 000 is allowed.
    const r = line([salary(200_000), ra(100_000)], 1_000_000, {
      period: { month: 2, year: 2027 },
      ytd: ytdOf({
        periods: 11, periodicTaxable: 2_200_000, retirementContributions: 330_000, retirementDeduction: 330_000,
        sdlApplicable: 2_200_000, sdlLeviable: 1_870_000,
      }),
    });
    expect(r.sdlLeviable).toBe(100_000);
    expect(r.sdl).toBe(1_000);
  });

  it('uses later remuneration headroom for an earlier disallowed contribution (PAYE-GEN-01-G21 (2027) Rev 1 s7.3.1)', () => {
    // Month 1: R8 000 contributed on R20 000 pay, only 27.5% = R5 500 allowed. Month 2 (no contribution) has
    // headroom: 27.5% × R40 000 = R11 000 ≥ R8 000 to date, so R2 500 more comes off.
    const r = line([salary(20_000)], 1_000_000, {
      period: { month: 4, year: 2026 },
      ytd: ytdOf({
        periods: 1, periodicTaxable: 20_000, retirementContributions: 8_000, retirementDeduction: 5_500,
        sdlApplicable: 20_000, sdlLeviable: 14_500,
      }),
    });
    expect(r.sdlLeviable).toBe(17_500);
    expect(r.sdl).toBe(175);
  });

  it('REPRO 1: a contribution made and fully reversed nets to the SDL of no contribution: R400 over two months (SDL Act s3(4); PAYE-GEN-01-G21 (2027) Rev 1 s7.3.1)', () => {
    const [m1, m2] = year([[salary(20_000), ra(5_000)], [salary(20_000), ra(-5_000)]]);
    expect(m1!.retirementDeduction + m2!.retirementDeduction).toBe(0);
    expect(m1!.sdlLeviable).toBe(15_000);
    expect(m2!.sdlLeviable).toBe(25_000);
    expect(totalSdl([m1!, m2!])).toBe(400);
  });

  it('REPRO 2: a deduction PAYE allows in a month with no SDL-applicable pay is recovered from the next month with some: R32 000 over three months', () => {
    // M1 R20 000 pay, RA R8 000 (27.5% = R5 500 allowed). M2 only non-SDL pay: the rest of the RA (R2 500) is
    // allowed, SDL has no pay to take it from. M3 R20 000: R20 000 + R20 000 pay less R8 000 = R32 000 to date.
    const rs = year([[salary(20_000), ra(8_000)], [nonSdl('3713', 40_000)], [salary(20_000)]]);
    expect(rs.map(r => r.retirementDeduction)).toEqual([5_500, 2_500, 0]);
    expect(rs.map(r => r.sdlLeviable)).toEqual([14_500, 0, 17_500]);
    expect(totalLeviable(rs)).toBe(32_000);
  });

  it('REPRO 3: a deduction floored away for want of SDL pay is not added back by a later reversal: R20 000 leviable in all', () => {
    const rs = year([[nonSdl('3713', 40_000), ra(8_000)], [salary(20_000), ra(-8_000)]]);
    expect(rs[0]!.retirementDeduction).toBe(8_000);
    expect(rs[0]!.sdlLeviable).toBe(0);
    expect(totalLeviable(rs)).toBe(20_000);
  });

  it('REPRO 4: a reversal on a line with only non-SDL earnings levies nothing', () => {
    const rs = year([[nonSdl('3713', 20_000), ra(5_000)], [nonSdl('3713', 20_000), ra(-5_000)]]);
    expect(rs[1]!.retirementDeduction).toBeLessThan(0);
    expect(totalLeviable(rs)).toBe(0);
  });

  it('REPRO 5: a reversal-only line (no earnings) levies nothing', () => {
    const rs = year([[nonSdl('3713', 20_000), ra(5_000)], [ra(-5_000)]]);
    expect(rs[1]!.sdlLeviable).toBe(0);
    expect(rs[1]!.sdl).toBe(0);
  });

  it('a deduction floored in month 1 (R1 000 SDL pay, R5 775 deduction) never takes the year above its SDL-applicable pay once reversed', () => {
    const rs = year([[salary(1_000), nonSdl('3713', 20_000), ra(8_000)], [salary(1_000), ra(-8_000)]]);
    expect(rs[0]!.retirementDeduction).toBe(5_775);
    expect(rs[0]!.sdlLeviable).toBe(0);
    expect(totalLeviable(rs)).toBeLessThanOrEqual(2_000);
    expect(totalLeviable(rs)).toBe(2_000);
  });

  it('a later month recovers an early excess, with PAYE unchanged by the SDL year to date', () => {
    const months = [[salary(20_000), ra(8_000)], [salary(20_000)], [salary(20_000)]];
    const withSdl = year(months);
    const payeOnly = year(months, false);
    expect(withSdl.map(r => r.paye.monthlyPaye)).toEqual(payeOnly.map(r => r.paye.monthlyPaye));
    expect(withSdl.map(r => r.retirementDeduction)).toEqual(payeOnly.map(r => r.retirementDeduction));
    expect(withSdl.map(r => r.netPay)).toEqual(payeOnly.map(r => r.netPay));
    // PAYE as 4c computes it (PAYE-GEN-01-G21 (2027) Rev 1 p. 10-11), pinned: R5 500 then R2 500 deducted, none after.
    expect(withSdl.map(r => [r.paye.monthlyPaye, r.netPay])).toEqual([[1_125, 10_697.88], [1_665, 18_157.88], [2_115, 17_707.88]]);
    // Pay R60 000 less the R8 000 PAYE finally allowed = R52 000 leviable.
    expect(withSdl.map(r => r.sdlLeviable)).toEqual([14_500, 17_500, 20_000]);
    expect(totalLeviable(withSdl)).toBe(52_000);
  });

  it('the line total is floored at nil: a deduction above the SDL-applicable pay leaves leviable and SDL nil (SDL Act s3(4))', () => {
    // R1 000 SDL-applicable + R20 000 taxable but SDL-excluded; RA R8 000. Base R21 000 x 27.5% = R5 775
    // allowed, more than the R1 000 that SDL can take it from. The excess is lost (documented limit).
    const sdlExcluded: EmployeeComponent = { component: comp('3713', { isSdlApplicable: false }), amount: 20_000 };
    const r = line([salary(1_000), sdlExcluded, ra(8_000)]);
    expect(r.retirementDeduction).toBe(5_775);
    expect(r.sdlLeviable).toBe(0);
    expect(r.sdl).toBe(0);
  });

  it('a catch-up month with no SDL-applicable pay at all has nil leviable and nil SDL', () => {
    const excluded: EmployeeComponent = { component: comp('3713', { isSdlApplicable: false }), amount: 20_000 };
    const r = line([excluded, ra(8_000)]);
    expect(r.retirementDeduction).toBe(5_500);
    expect(r.sdlLeviable).toBe(0);
    expect(r.sdl).toBe(0);
  });

  it('refuses a non-finite retirement deduction or year-to-date figure instead of letting NaN reach SDL and the run totals', () => {
    const bad = (extra: Partial<PayeYearToDate>) => () => line([salary(20_000), ra(5_000)], 1_000_000, {
      period: { month: 4, year: 2026 },
      ytd: ytdOf({ periods: 1, periodicTaxable: 20_000, retirementContributions: 5_000, retirementDeduction: 5_000, sdlApplicable: 20_000, sdlLeviable: 15_000, ...extra }),
    });
    expect(bad({ retirementDeduction: Number.NaN })).toThrow(/not a finite number/);
    expect(bad({ sdlApplicable: Number.NaN })).toThrow(/ytdSdlApplicable is not a finite number/);
    expect(bad({ sdlLeviable: Number.POSITIVE_INFINITY })).toThrow(/ytdSdlLeviable is not a finite number/);
  });

  it('one-pass SDL is charged on the cent-rounded leviable amount, as the run pass recomputes it (applySdlToLines)', () => {
    // R1 000.496 rounds to R1 000.50 on the line; 1% of the unrounded figure is R10.00, of the rounded R10.01.
    const r = line([salary(1_000.496)]);
    expect(r.sdlLeviable).toBe(1_000.5);
    expect(r.sdl).toBe(10.01);
    const lines = [{ sdl: 0, sdlLeviable: r.sdlLeviable }];
    applySdlToLines(lines, 1_000_000, 2027);
    expect(r.sdl).toBe(lines[0]!.sdl);
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

  it('SDL exclusions still apply; s11F cap uses total Fourth Schedule remuneration as the 27.5% base (SDL-GEN-01-G01 Rev 5 s6)', () => {
    // R5 000 SDL-applicable + R10 000 taxable but SDL-excluded; RA R8 000.
    // 27.5% of R15 000 (total taxable remuneration) = R4 125; SDL leviable = R5 000 − R4 125 = R875.
    const sdlExcluded: EmployeeComponent = { component: comp('3713', { isSdlApplicable: false }), amount: 10_000 };
    const r = line([salary(5_000), sdlExcluded, ra(8_000)]);
    expect(r.retirementDeduction).toBe(4_125);
    expect(r.sdlLeviable).toBeCloseTo(875, 2);
    expect(r.sdl).toBeCloseTo(8.75, 2);
  });

  it('s11F cap limits the deduction to 27.5% even when the contribution exceeds remuneration (PAYE-GEN-01-G21 (2027) Rev 1 s7.3.1)', () => {
    // Salary R3 000; RA R5 000 (167%): allowed 27.5% × R3 000 = R825; SDL leviable = R2 175.
    const r = line([salary(3_000), ra(5_000)]);
    expect(r.retirementDeduction).toBe(825);
    expect(r.sdlLeviable).toBeCloseTo(2_175, 2);
    expect(r.sdl).toBeCloseTo(21.75, 2);
  });
});

describe('SDL: deductions outside the para 2(4) retirement allowlist (SDL-GEN-01-G01 Rev 5 s6)', () => {
  it('does not deduct 4030 without a modelled s18A receipt and approved organisation', () => {
    const r = line([salary(30_000), donation(10_000)]);
    expect(r.taxableIncome).toBe(20_000);
    expect(r.sdlLeviable).toBe(30_000);
    expect(r.sdl).toBe(300);
  });

  it('non-allowlisted taxable deduction (union fees 4018) reduces PAYE but NOT SDL', () => {
    const r = line([salary(30_000), unionFees(1_000)]);
    expect(r.taxableIncome).toBe(29_000);
    expect(r.sdlLeviable).toBe(30_000);
    expect(r.sdl).toBe(300);
  });

  it('medical aid (4005) does not reduce SDL', () => {
    const r = line([salary(30_000), deduction('4005', 2_000)]);
    expect(r.sdlLeviable).toBe(30_000);
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
    expect(applySdlToLines([{ sdl: 0, sdlLeviable: deferred.sdlLeviable }], 600_000, 2027)).toBe(277.5);
    expect(applySdlToLines([{ sdl: 0, sdlLeviable: deferred.sdlLeviable }], 480_000, 2027)).toBe(0);
  });
});
