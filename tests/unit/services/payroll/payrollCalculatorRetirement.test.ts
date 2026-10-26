/**
 * PAYE 4c: retirement fund contributions in the payroll line
 * (payrollCalculator → payeCumulative; rules and sources in retirementFund.ts).
 * A deduction coded 4001 (pension), 4003 (provident) or 4006 (retirement
 * annuity) is a contribution, by its code: it is deducted from remuneration
 * before PAYE within section 11F, not through the uncapped taxable-deduction
 * path. Employer fund contributions (PAYE 4b) are not supported and warned on.
 *
 * Hand figures (2027 table, payeRetirementFund.test.ts): employee A, R60 000
 * with R2 708.59 to a retirement annuity and four medical beneficiaries,
 * deducts 12 440.49 (Sage: 12 440.51); R20 000 with R8 000 is capped at 27.5%
 * (5 500) and deducts 1 125, uncapped it would be 675.
 */
import { describe, expect, it } from 'vitest';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import type { EmployeeComponent, PayrollComponent, PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';

const employee = (beneficiaries = 0, uifExcluded = true) => ({
  id: 'emp-1',
  dateOfBirth: new Date(1976, 9, 19),
  startDate: new Date(2015, 0, 1),
  uifExcluded,
  medicalAidMainMember: beneficiaries > 0,
  medicalAidDependantsCount: Math.max(0, beneficiaries - 1),
}) as unknown as PayrollEmployee;

const comp = (code: string, extra: Partial<PayrollComponent> = {}): PayrollComponent => ({
  id: `c-${code}`, name: `Code ${code}`, sarsSourceCode: code, componentType: 'earning',
  isTaxable: true, isUifApplicable: true, isSdlApplicable: true, ...extra,
});
const deduction = (code: string, extra: Partial<PayrollComponent> = {}) => comp(code, { componentType: 'deduction', ...extra });

function line(components: EmployeeComponent[], beneficiaries = 0, uifExcluded = true) {
  return calculatePayrollLine({
    employee: employee(beneficiaries, uifExcluded),
    components,
    period: { month: 10, year: 2026 },
    taxYear: 2027,
    annualPayrollEstimate: 'defer',
  });
}

describe('PAYE 4c: a retirement fund contribution in the line', () => {
  it('employee A: R60 000 and a 4006 deduction of R2 708.59, four beneficiaries: PAYE 12 440.49', () => {
    const l = line([{ component: comp('3601'), amount: 60_000 }, { component: deduction('4006'), amount: 2_708.59 }], 4, false);
    expect(l.paye.monthlyPaye).toBe(12_440.49);
    expect([l.retirementContributions, l.retirementDeduction]).toEqual([2_708.59, 2_708.59]);
    // periodicTaxable is remuneration before the deduction (the next month's year to date); taxableIncome after it.
    expect([l.periodicTaxable, l.taxableIncome]).toEqual([60_000, 57_291.41]);
    expect(l.medicalCredit).toBe(1_260);
    // Paid through payroll: it comes off net pay. 60 000 − 2 708.59 − 12 440.49 − UIF 177.12.
    expect(l.netPay).toBe(44_673.8);
  });

  it('by code, not by the taxable flag: a 4001 deduction flagged non-taxable is still deducted', () => {
    const l = line([{ component: comp('3601'), amount: 60_000 }, { component: deduction('4001', { isTaxable: false }), amount: 2_708.59 }], 4);
    expect(l.paye.monthlyPaye).toBe(12_440.49);
  });

  it('a 4003 provident contribution counts as well', () => {
    const l = line([{ component: comp('3601'), amount: 60_000 }, { component: deduction(' 4003 '), amount: 2_708.59 }], 4);
    expect([l.paye.monthlyPaye, l.retirementContributions]).toEqual([12_440.49, 2_708.59]);
  });

  it('capped, not through the uncapped taxable-deduction path: R20 000 with R8 000 deducts 5 500 and PAYE 1 125', () => {
    const l = line([{ component: comp('3601'), amount: 20_000 }, { component: deduction('4006'), amount: 8_000 }]);
    expect([l.paye.monthlyPaye, l.retirementDeduction, l.taxableIncome]).toEqual([1_125, 5_500, 14_500]);
    expect(l.netPay).toBe(20_000 - 8_000 - 1_125);
  });

  it('a non-retirement deduction keeps its taxable flag\'s meaning (unchanged by 4c)', () => {
    const l = line([{ component: comp('3601'), amount: 20_000 }, { component: deduction('4030'), amount: 8_000 }]);
    expect([l.paye.monthlyPaye, l.retirementDeduction]).toEqual([675, 0]);
  });
});

describe('PAYE 4c: a contribution paid outside payroll (paid_outside_payroll, migration 948)', () => {
  // A retirement annuity the employee pays the fund directly (a Sage "Private RA"): counted for the s11F
  // deduction and the certificate, never deducted from pay. Employee A: Sage nett 60 000 − 12 440.51 − 177.12.
  it('employee A with a private RA: PAYE 12 440.49, net pay not reduced by it (60 000 − 12 440.49 − 177.12)', () => {
    const l = line([
      { component: comp('3601'), amount: 60_000 },
      { component: deduction('4006', { paidOutsidePayroll: true }), amount: 2_708.59 },
    ], 4, false);
    expect(l.paye.monthlyPaye).toBe(12_440.49);
    expect([l.retirementContributions, l.retirementDeduction]).toEqual([2_708.59, 2_708.59]);
    expect(l.netPay).toBe(47_382.39);
    // The breakdown says so, so gross − its deductions − PAYE − UIF still explains the net pay.
    expect(l.componentBreakdown.find(i => i.sarsSourceCode === '4006')?.paidOutsidePayroll).toBe(true);
  });

  it('beside one paid through payroll: only the payroll one comes off net pay; both count towards the cap', () => {
    const l = line([
      { component: comp('3601'), amount: 20_000 },
      { component: deduction('4006', { paidOutsidePayroll: true }), amount: 4_000 },
      { component: deduction('4001'), amount: 4_000 },
    ]);
    expect([l.paye.monthlyPaye, l.retirementDeduction]).toEqual([1_125, 5_500]);
    expect(l.netPay).toBe(20_000 - 4_000 - 1_125);
  });
});

describe('PAYE 4c: employer fund contributions (4b) are not handled silently', () => {
  it('an employer-contribution component is left out of pay and PAYE, with an error-level warning', () => {
    const withIt = line([
      { component: comp('3601'), amount: 20_000 },
      { component: comp('4474', { componentType: 'employer_contribution', name: 'Company RA' }), amount: 1_000 },
    ]);
    const without = line([{ component: comp('3601'), amount: 20_000 }]);
    expect([withIt.grossPay, withIt.paye.monthlyPaye, withIt.netPay]).toEqual([without.grossPay, without.paye.monthlyPaye, without.netPay]);
    const w = withIt.validationResults.find(v => v.code === 'EMPLOYER_CONTRIBUTION_NOT_SUPPORTED');
    expect(w?.severity).toBe('error');
    expect(w?.message).toContain('Company RA');
  });

  it('an earning coded as the benefit of an employer fund contribution (3817/3825/3828) warns that no deemed contribution was deducted', () => {
    for (const code of ['3817', '3825', '3828']) {
      const l = line([{ component: comp('3601'), amount: 20_000 }, { component: comp(code), amount: 1_000 }]);
      expect(l.validationResults.map(v => v.code), code).toContain('EMPLOYER_FUND_BENEFIT_NOT_DEEMED');
    }
    expect(line([{ component: comp('3601'), amount: 20_000 }]).validationResults.map(v => v.code)).not.toContain('EMPLOYER_FUND_BENEFIT_NOT_DEEMED');
  });
});
