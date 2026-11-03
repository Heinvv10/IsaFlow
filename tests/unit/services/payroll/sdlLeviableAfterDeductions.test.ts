/**
 * SDL is levied on the BALANCE of remuneration: SDL-applicable remuneration
 * less the paragraph 2(4) Fourth Schedule deductions, never below nil.
 *
 * Sources: SARS SDL-GEN-01-G01 Rev 5 s6; PAYE-GEN-01-G21 (2027 tax year)
 * 'SDL liable amount'; SDL Act s3(4); PAYE-GEN-01-G21 (2027) Rev 1 s7.3.1;
 * PAYE-GEN-01-G20 (2026) s7.3.1.
 *
 * Retirement-fund contributions (4001/4003/4006) are capped by s11F: the
 * lesser of 27.5% of remuneration and the annual cap apportioned to the period
 * (R430 000/12 for 2027; R350 000/12 for 2026). Other taxable deductions are
 * not capped for SDL. PAYE does NOT yet apply this cap (pending PR #891), so
 * for contributions above the cap the PAYE base and SDL base differ temporarily.
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
const donation = (amount: number): EmployeeComponent => ({
  component: comp('4030', { componentType: 'deduction', isUifApplicable: false, isSdlApplicable: false }), amount,
});
const unionFees = (amount: number): EmployeeComponent => ({
  // 4018 = Union dues; isTaxable defaults to true via comp()
  component: comp('4018', { componentType: 'deduction', isUifApplicable: false, isSdlApplicable: false }), amount,
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

  it('recognises seeded retirement components even when isTaxable is false', () => {
    const seededPension: EmployeeComponent = {
      component: comp('4001', { componentType: 'deduction', isTaxable: false, isUifApplicable: false, isSdlApplicable: false }),
      amount: 2_250,
    };
    const r = line([salary(30_000), seededPension]);
    expect(r.taxableIncome).toBe(30_000);
    expect(r.sdlLeviable).toBe(27_750);
  });

  it('s11F cap applied to SDL: R20 000 salary + R8 000 RA (40%) → SDL deducts R5 500 (27.5% cap), SDL = R145', () => {
    // Sources: SARS PAYE-GEN-01-G21 (2027) Rev 1 s7.3.1; PAYE-GEN-01-G20 (2026) s7.3.1;
    //          SDL-GEN-01-G01 Rev 5 s6.
    // 27.5% × R20 000 = R5 500 < R430 000/12 = R35 833, so percentage cap binds.
    // PAYE still deducts R8 000 in full (uncapped, pending PR #891).
    const r = line([salary(20_000), ra(8_000)]);
    const payeDeduction = 20_000 - r.taxableIncome;
    expect(payeDeduction).toBe(8_000);        // PAYE uncapped
    expect(r.sdlLeviable).toBe(14_500);       // SDL capped: 20 000 - 5 500
    expect(r.sdl).toBe(145);                  // 14 500 × 1%
  });

  it('s11F cap — annual-cap boundary (2027: R430 000/12 ≈ R35 833): cap binds above 27.5%', () => {
    // Sources: SARS PAYE-GEN-01-G21 (2027) Rev 1 s7.3.1; SDL-GEN-01-G01 Rev 5 s6.
    // Salary R200 000/month; 27.5% = R55 000 > R430 000/12 ≈ R35 833 → annual cap binds.
    const r = line([salary(200_000), ra(55_000)]);
    const annualCapMonthly = 430_000 / 12; // ≈ 35 833.333...
    const expectedLeviable = Math.max(0, 200_000 - annualCapMonthly);
    expect(r.sdlLeviable).toBeCloseTo(expectedLeviable, 2);
    expect(r.sdl).toBeCloseTo(expectedLeviable * 0.01, 2);
  });

  it('uses the remaining cumulative annual cap for a February catch-up contribution', () => {
    const r = calculatePayrollLine({
      employee: {
        id: 'emp-1', companyId: 'co-1', employeeNumber: 'E1', firstName: 'A', lastName: 'B',
        idNumber: '9001015009087', taxNumber: '1234567890', employmentType: 'permanent',
        startDate: new Date('2020-01-01'), dateOfBirth: new Date('1990-01-01'),
        uifExcluded: false, medicalAidMainMember: false, medicalAidDependantsCount: 0,
      },
      components: [salary(200_000), ra(100_000)],
      period: { month: 2, year: 2027 }, taxYear: 2027, annualPayrollEstimate: 1_000_000,
      ytd: {
        periods: 11, periodicTaxable: 1_870_000, annualPayments: 0, tablePaye: 0,
        medicalCredit: 0, additionalMedicalCredit: 0, medicalSchemeFees: 0,
        sdlRemuneratedPeriods: 11, sdlRemuneration: 2_200_000, sdlRetirementContributions: 330_000,
      },
    });
    expect(r.sdlLeviable).toBe(100_000);
    expect(r.sdl).toBe(1_000);
  });

  it('s11F cap — 2026 tax year (R350 000 annual cap): monthly cap ≈ R29 167', () => {
    // Sources: SARS PAYE-GEN-01-G20 (2026) s7.3.1; SDL-GEN-01-G01 Rev 5 s6.
    const r2026 = (components: EmployeeComponent[]): ReturnType<typeof calculatePayrollLine> => {
      const input: PayrollLineInput = {
        employee: {
          id: 'emp-2026', companyId: 'co-1', employeeNumber: 'E2', firstName: 'A', lastName: 'B',
          idNumber: '9001015009087', taxNumber: '1234567890', employmentType: 'permanent',
          startDate: new Date('2020-01-01'), dateOfBirth: new Date('1990-01-01'),
          uifExcluded: false, medicalAidMainMember: false, medicalAidDependantsCount: 0,
        },
        components,
        period: { month: 6, year: 2025 }, // June 2025 → tax year 2026
        taxYear: 2026,
        annualPayrollEstimate: 1_000_000,
      };
      return calculatePayrollLine(input);
    };
    // Salary R200 000; 27.5% = R55 000 > R350 000/12 ≈ R29 167 → annual cap binds.
    const r = r2026([salary(200_000), ra(55_000)]);
    const annualCapMonthly2026 = 350_000 / 12; // ≈ 29 166.667
    const expectedLeviable = Math.max(0, 200_000 - annualCapMonthly2026);
    expect(r.sdlLeviable).toBeCloseTo(expectedLeviable, 2);
    expect(r.sdl).toBeCloseTo(expectedLeviable * 0.01, 2);
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

  it('SDL exclusions still apply; s11F cap uses total Fourth Schedule remuneration as the 27.5% base', () => {
    // Sources: SARS PAYE-GEN-01-G21 (2027) Rev 1 s7.3.1; SDL-GEN-01-G01 Rev 5 s6.
    // R5 000 SDL-applicable + R10 000 taxable but SDL-excluded.
    // RA R8 000 deduction: 27.5% of R15 000 (total taxable) = R4 125 (percentage cap binds).
    // PAYE allows R8 000 in full (uncapped, pending PR #891).
    // SDL leviable = max(0, R5 000 − R4 125) = R875.
    const sdlExcluded: EmployeeComponent = { component: comp('3713', { isSdlApplicable: false }), amount: 10_000 };
    const r = line([salary(5_000), sdlExcluded, ra(8_000)]);
    expect(r.taxableIncome).toBe(7_000);            // PAYE uncapped
    expect(r.sdlLeviable).toBeCloseTo(875, 2);
    expect(r.sdl).toBeCloseTo(8.75, 2);
  });

  it('s11F cap limits the deduction to 27.5% even when the contribution exceeds remuneration', () => {
    // Sources: SARS PAYE-GEN-01-G21 (2027) Rev 1 s7.3.1; SDL-GEN-01-G01 Rev 5 s6.
    // Salary R3 000; RA R5 000 (167% — far above s11F).
    // s11F cap = 27.5% × R3 000 = R825; SDL leviable = R3 000 − R825 = R2 175.
    // PAYE allows min(R5 000, R3 000) = R3 000 in full (uncapped, pending PR #891),
    // so taxableIncome = 0, while sdlLeviable = R2 175: bases diverge.
    const r = line([salary(3_000), ra(5_000)]);
    expect(r.taxableIncome).toBe(0);          // PAYE: deduction absorbs all taxable income
    expect(r.sdlLeviable).toBeCloseTo(2_175, 2);
    expect(r.sdl).toBeCloseTo(21.75, 2);
  });
});

describe('SDL para 2(4)(f): unsupported donation qualification', () => {
  it('does not deduct 4030 without a modelled s18A receipt and approved organisation', () => {
    const r = line([salary(30_000), donation(10_000)]);
    expect(r.taxableIncome).toBe(20_000);
    expect(r.sdlLeviable).toBe(30_000);
    expect(r.sdl).toBe(300);
  });

  it('non-allowlisted taxable deduction (union fees 4018) does NOT reduce SDL', () => {
    // Union fees are taxable deductions for PAYE but are not in the SDL para 2(4)
    // allowlist. They reduce PAYE taxableIncome but leave SDL leviable unchanged.
    // R30 000 salary + R1 000 union fees: taxableIncome = R29 000, sdlLeviable = R30 000.
    const r = line([salary(30_000), unionFees(1_000)]);
    expect(r.taxableIncome).toBe(29_000); // PAYE reduced
    expect(r.sdlLeviable).toBe(30_000);   // SDL not reduced
    expect(r.sdl).toBe(300);
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
