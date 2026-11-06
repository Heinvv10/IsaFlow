/**
 * Donations (4030) under SARS PAYE-GEN-01-G21 (2027) Rev 1 "Donations" (para 2(4)(f); s18A(2)(a)): the deduction
 * "may not exceed 5% of remuneration after deducting pension, provident and retirement annuity fund contributions"
 * and "is only allowed if employee has provided employer with receipt". G21 "SDL liable amount": SDL is on the
 * balance of remuneration after allowable deductions, donations included.
 */
import { describe, it, expect } from 'vitest';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import type {
  EmployeeComponent, PayeYearToDate, PayrollComponent, PayrollLineInput, PayrollLineResult,
} from '@/modules/accounting/services/payroll/payrollTypes';

function comp(code: string, extra: Partial<PayrollComponent> = {}): PayrollComponent {
  return {
    id: `c-${code}`, name: code, sarsSourceCode: code, componentType: 'earning',
    isTaxable: true, isUifApplicable: true, isSdlApplicable: true, ...extra,
  };
}
const deduction = (code: string, amount: number): EmployeeComponent => ({
  component: comp(code, { componentType: 'deduction', isUifApplicable: false, isSdlApplicable: false }), amount,
});
const salary = (amount: number): EmployeeComponent => ({ component: comp('3601'), amount });
const bonus = (amount: number): EmployeeComponent => ({ component: comp('3605'), amount });
const donation = (amount: number): EmployeeComponent => deduction('4030', amount);
const ra = (amount: number): EmployeeComponent => deduction('4006', amount);

const employee = (s18aReceiptHeld: boolean): PayrollLineInput['employee'] => ({
  id: 'emp-1', companyId: 'co-1', employeeNumber: 'E1', firstName: 'A', lastName: 'B',
  idNumber: '9001015009087', taxNumber: '1234567890', employmentType: 'permanent',
  startDate: new Date('2020-01-01'), dateOfBirth: new Date('1990-01-01'),
  uifExcluded: false, medicalAidMainMember: false, medicalAidDependantsCount: 0, s18aReceiptHeld,
});

function line(components: EmployeeComponent[], held = true, ytd?: PayeYearToDate): PayrollLineResult {
  return calculatePayrollLine({
    employee: employee(held), components, period: { month: 6, year: 2026 }, taxYear: 2027,
    annualPayrollEstimate: 1_000_000, ...(ytd ? { ytd } : {}),
  });
}

/** The year to date the next line reads, from this line and the one before (as loadPayeYearToDate sums them). */
function next(l: PayrollLineResult, before?: PayeYearToDate): PayeYearToDate {
  return {
    periods: (before?.periods ?? 0) + 1,
    retirementCapPeriods: (before?.retirementCapPeriods ?? 0) + 1,
    periodicTaxable: (before?.periodicTaxable ?? 0) + l.periodicTaxable,
    annualPayments: (before?.annualPayments ?? 0) + l.annualTaxable,
    tablePaye: (before?.tablePaye ?? 0) + l.paye.monthlyPaye,
    medicalCredit: 0, additionalMedicalCredit: 0, medicalSchemeFees: 0,
    retirementContributions: (before?.retirementContributions ?? 0) + l.retirementContributions,
    retirementDeduction: (before?.retirementDeduction ?? 0) + l.retirementDeduction,
    donations: (before?.donations ?? 0) + l.donationDeduction,
    donationReceipted: (before?.donationReceipted ?? 0) + l.donationReceipted,
    donationBase: (before?.donationBase ?? 0) + l.donationBase,
    donationDeduction: (before?.donationDeduction ?? 0) + l.donationDeduction,
    sdlApplicable: (before?.sdlApplicable ?? 0) + l.sdlApplicable,
    sdlLeviable: (before?.sdlLeviable ?? 0) + l.sdlLeviable,
    sdlRetirementDeduction: (before?.sdlRetirementDeduction ?? 0) + l.retirementDeduction + l.donationDeduction,
  };
}

const codes = (l: PayrollLineResult) => l.validationResults.map(v => v.code);

describe('4030 with no s18A receipt: no deduction', () => {
  it('R30 000, R1 000 donated: taxed and levied on all R30 000, still paid over and warned', () => {
    const l = line([salary(30_000), donation(1_000)], false);
    expect([l.donationDeduction, l.donationReceipted, l.taxableIncome, l.sdlLeviable, l.sdl]).toEqual([0, 0, 30_000, 30_000, 300]);
    // R30 000 taxes as if undonated: the donation still leaves net pay.
    const without = line([salary(30_000)], false);
    expect(l.paye.monthlyPaye).toBe(without.paye.monthlyPaye);
    expect(l.netPay).toBe(without.netPay - 1_000);
    expect(codes(l)).toContain('DONATION_WITHOUT_S18A_RECEIPT');
  });

  it('the full donation stays on the line for the certificate (reflect under 4030, not only the allowable portion)', () => {
    const l = line([salary(30_000), donation(1_000)], false);
    expect(l.componentBreakdown.find(i => i.sarsSourceCode === '4030')?.amount).toBe(1_000);
  });

  it('no donation, no warning', () => {
    expect(codes(line([salary(30_000)], false))).not.toContain('DONATION_WITHOUT_S18A_RECEIPT');
  });
});

describe('4030 with a receipt: 5% of remuneration after fund contributions', () => {
  it('under the limit: R30 000, R1 000 donated deducts all of it from PAYE and SDL', () => {
    const l = line([salary(30_000), donation(1_000)]);
    expect([l.donationDeduction, l.taxableIncome, l.sdlLeviable, l.sdl]).toEqual([1_000, 29_000, 29_000, 290]);
    expect(codes(l)).not.toContain('DONATION_ABOVE_S18A_LIMIT');
  });

  it('over the limit: R30 000, R10 000 donated deducts 5% = R1 500, warned; R10 000 still leaves net pay', () => {
    const l = line([salary(30_000), donation(10_000)]);
    expect([l.donationDeduction, l.taxableIncome, l.sdlLeviable, l.sdl]).toEqual([1_500, 28_500, 28_500, 285]);
    expect(codes(l)).toContain('DONATION_ABOVE_S18A_LIMIT');
    expect(l.netPay).toBeCloseTo(line([salary(30_000), donation(1_500)]).netPay - 8_500, 2);
  });

  it('after fund contributions: R20 000, R8 000 RA (R5 500 allowed), R1 000 donated deducts 5% × 14 500 = R725', () => {
    // 240 000 − 66 000 (s11F, base before the donation) − 8 700 = 165 300 × 18% = 29 754 − 17 820 = 11 934 ÷ 12 = 994.50.
    const l = line([salary(20_000), ra(8_000), donation(1_000)]);
    expect([l.retirementDeduction, l.donationDeduction, l.paye.monthlyPaye]).toEqual([5_500, 725, 994.5]);
    expect(l.sdlLeviable).toBe(13_775);
  });

  it('remuneration includes the annual payment: R10 000 + R20 000 bonus, R2 000 donated deducts 5% × 30 000 = R1 500', () => {
    expect(line([salary(10_000), bonus(20_000), donation(2_000)]).donationDeduction).toBe(1_500);
  });

  it('a non-taxable 4030 component stays outside the rule', () => {
    const l = line([salary(30_000), { component: comp('4030', { componentType: 'deduction', isTaxable: false }), amount: 1_000 }]);
    expect([l.donationDeduction, l.donationReceipted, l.taxableIncome]).toEqual([0, 0, 30_000]);
    expect(codes(l)).not.toContain('DONATION_ABOVE_S18A_LIMIT');
  });
});

describe('4030 is cumulative over the tax year', () => {
  it('capped in month 1, the excess comes off in month 2 as the 5% grows', () => {
    const m1 = line([salary(20_000), donation(2_000)]);
    expect(m1.donationDeduction).toBe(1_000);
    const m2 = line([salary(20_000)], true, next(m1));
    expect([m2.donationDeduction, m2.sdlLeviable, m2.periodicTaxable]).toEqual([1_000, 19_000, 19_000]);
    const m3 = line([salary(20_000)], true, next(m2, next(m1)));
    expect(m3.donationDeduction).toBe(0);
  });

  it('a reversal takes back what was allowed: R1 000, then −R1 000', () => {
    const m1 = line([salary(20_000), donation(1_000)]);
    const m2 = line([salary(20_000), donation(-1_000)], true, next(m1));
    expect([m2.donationDeduction, m2.taxableIncome, m2.sdlLeviable]).toEqual([-1_000, 21_000, 20_000 + 1_000]);
  });

  it('a reversal counts even after the receipt flag is cleared', () => {
    const m1 = line([salary(20_000), donation(1_000)]);
    expect(line([salary(20_000), donation(-1_000)], false, next(m1)).donationDeduction).toBe(-1_000);
  });

  it('earlier lines from before the rule give no credit and no clawback: the 5% starts with this line', () => {
    const ytd: PayeYearToDate = {
      periods: 1, retirementCapPeriods: 1, periodicTaxable: 10_000, annualPayments: 0, tablePaye: 0, medicalCredit: 0,
      additionalMedicalCredit: 0, medicalSchemeFees: 0, retirementContributions: 0, retirementDeduction: 0,
      donations: 10_000, donationReceipted: 0, donationBase: 0, donationDeduction: 0,
      sdlApplicable: 20_000, sdlLeviable: 20_000, sdlRetirementDeduction: 0,
    };
    const l = line([salary(20_000), donation(500)], true, ytd);
    expect(l.donationDeduction).toBe(500);
  });

  it('reversing a donation from before the rule still takes it back', () => {
    const ytd: PayeYearToDate = {
      periods: 1, retirementCapPeriods: 1, periodicTaxable: 19_000, annualPayments: 0, tablePaye: 0, medicalCredit: 0,
      additionalMedicalCredit: 0, medicalSchemeFees: 0, retirementContributions: 0, retirementDeduction: 0,
      donations: 1_000, donationReceipted: 0, donationBase: 0, donationDeduction: 0,
      sdlApplicable: 20_000, sdlLeviable: 20_000, sdlRetirementDeduction: 0,
    };
    expect(line([salary(20_000), donation(-1_000)], true, ytd).donationDeduction).toBe(-1_000);
  });
});
