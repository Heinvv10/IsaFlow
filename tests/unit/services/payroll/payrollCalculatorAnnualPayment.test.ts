/**
 * Audit 2026-10-18 P3: PAYE on an annual payment (code 3605) and on a lump sum
 * (39xx) is not the monthly tax on that amount ×12.
 *
 * SARS, Guide for Employers in respect of Employees' Tax (2027 tax year),
 * PAYE-GEN-01-G21 Revision 1, "Annual payments/bonus", p. 32–33
 * (https://www.sars.gov.za/wp-content/uploads/Ops/Guides/PAYE-GEN-01-G21-Guide-for-Employers-iro-Employees-Tax-for-2027-External-Guide.pdf):
 * "the annual equivalent of the remuneration earned during the tax period ...
 * adding the annual payment to the result. The difference between tax on the
 * total result (annual equivalent plus annual payment) and tax on the annual
 * equivalent will result in employees' tax deductible from annual payment."
 *
 * The guide's worked example (salary R28 000, bonus R14 800, below 65) prints
 * tax on R336 000 = 49 945 and on R350 800 = 53 723 (bonus tax 3 778): those
 * are read off SARS's banded deduction tables, not the statutory rate table.
 * The calculator applies the rate table (taxTables.ts, 2027:
 * https://www.sars.gov.za/tax-rates/income-tax/rates-of-tax-for-individuals/),
 * so every figure below is recomputed from it by hand:
 *   2027 bracket 2: 44 118 + 26% of income above 245 100; primary rebate 17 820.
 *   tax(336 000) = 44 118 + 0.26 × 90 900  = 67 752 − 17 820 = 49 932
 *   tax(350 800) = 44 118 + 0.26 × 105 700 = 71 600 − 17 820 = 53 780
 *   bonus tax = 53 780 − 49 932 = 3 848; salary tax = 49 932 / 12 = 4 161.00
 * The method is the guide's; only the table rounding differs.
 */
import { describe, expect, it } from 'vitest';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import { normaliseSarsCode, payeTreatment } from '@/modules/accounting/services/payroll/payeAnnualPayment';
import type { EmployeeComponent, PayrollComponent, PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';

const employee = (beneficiaries = 0) => ({
  id: 'emp-1',
  dateOfBirth: new Date(1990, 0, 1),
  startDate: new Date(2015, 0, 1),
  uifExcluded: true,
  medicalAidMainMember: beneficiaries > 0,
  medicalAidDependantsCount: Math.max(0, beneficiaries - 1),
}) as unknown as PayrollEmployee;

const comp = (code: string, extra: Partial<PayrollComponent> = {}): PayrollComponent => ({
  id: `c-${code}`, name: code, sarsSourceCode: code, componentType: 'earning',
  isTaxable: true, isUifApplicable: false, isSdlApplicable: false, ...extra,
});

function line(components: EmployeeComponent[], beneficiaries = 0) {
  return calculatePayrollLine({
    employee: employee(beneficiaries),
    components,
    period: { month: 10, year: 2026 },
    taxYear: 2027,
    annualPayrollEstimate: 'defer',
  });
}

describe('P3: an annual payment (3605) is taxed by the SARS annual-payment method', () => {
  it("the guide's October bonus: salary tax 4 161.00 plus bonus tax 3 848.00", () => {
    const l = line([{ component: comp('3601'), amount: 28_000 }, { component: comp('3605'), amount: 14_800 }]);
    expect(l.payeSplit).toEqual({ regular: 4161, annualPayment: 3848, directive: 0 });
    expect(l.paye.monthlyPaye).toBe(8009);
    expect(l.taxableIncome).toBe(42_800);
  });

  it('medical credits are applied once, in the regular calculation', () => {
    // Two beneficiaries: 2 × 376 × 12 = 9 024 a year (taxTables.ts 2027).
    // Salary: (49 932 − 9 024) / 12 = 3 409.00; the bonus tax is unchanged.
    const l = line([{ component: comp('3601'), amount: 28_000 }, { component: comp('3605'), amount: 14_800 }], 2);
    expect(l.payeSplit).toEqual({ regular: 3409, annualPayment: 3848, directive: 0 });
  });

  it('a bonus with no regular pay: tax(120 000) = 21 600 − 17 820 = 3 780', () => {
    const l = line([{ component: comp('3605'), amount: 120_000 }]);
    expect(l.payeSplit).toEqual({ regular: 0, annualPayment: 3780, directive: 0 });
  });

  it('an employee under the threshold until the bonus: only the excess is taxed', () => {
    // R7 000 × 12 = 84 000, below the R99 000 threshold: no tax.
    // 84 000 + 30 000 = 114 000: 20 520 − 17 820 = 2 700.
    const l = line([{ component: comp('3601'), amount: 7_000 }, { component: comp('3605'), amount: 30_000 }]);
    expect(l.payeSplit).toEqual({ regular: 0, annualPayment: 2700, directive: 0 });
  });

  it('leave pay-out and notice pay in a final run are both annual payments', () => {
    // Salary 21 670 × 12 = 260 040: 44 118 + 0.26 × 14 940 = 48 002.40 − 17 820 = 30 182.40 → 2 515.20 a month.
    // Plus 30 000: 290 040: 44 118 + 0.26 × 44 940 = 55 802.40 − 17 820 = 37 982.40. Difference 7 800.00.
    const l = line([
      { component: comp('3601'), amount: 21_670 },
      { component: { ...comp('3605'), id: 'synthetic:termination:leave-payout' }, amount: 10_000 },
      { component: { ...comp('3605'), id: 'synthetic:termination:notice-pay' }, amount: 20_000 },
    ]);
    expect(l.payeSplit).toEqual({ regular: 2515.2, annualPayment: 7800, directive: 0 });
    expect(l.paye.monthlyPaye).toBe(10_315.2);
  });

  it('a periodic code is still annualised ×12', () => {
    // 20 000 × 12 = 240 000 × 18% = 43 200 − 17 820 = 25 380 / 12 = 2 115.00.
    const l = line([{ component: comp('3601'), amount: 20_000 }]);
    expect(l.payeSplit).toEqual({ regular: 2115, annualPayment: 0, directive: 0 });
  });
});

describe('P3: a lump sum (39xx) is never taxed by the tables', () => {
  it('without a directive it carries no PAYE and the line warns', () => {
    const l = line([{ component: comp('3601'), amount: 20_000 }, { component: comp('3901'), amount: 50_000 }]);
    expect(l.payeSplit).toEqual({ regular: 2115, annualPayment: 0, directive: 0 });
    expect(l.grossPay).toBe(70_000);
    expect(l.taxableIncome).toBe(20_000);
    expect(l.validationResults.map(v => v.code)).toContain('LUMP_SUM_WITHOUT_DIRECTIVE');
  });

  it('flagged not taxable, it still warns: a lump sum needs a directive before it is paid at all', () => {
    const l = line([{ component: comp('3601'), amount: 20_000 }, { component: comp('3901', { isTaxable: false }), amount: 50_000 }]);
    expect(l.validationResults.map(v => v.code)).toContain('LUMP_SUM_WITHOUT_DIRECTIVE');
    expect(l.payeSplit.directive).toBe(0);
  });

  it("with a directive it carries the directive's PAYE, untouched", () => {
    const l = line([
      { component: comp('3601'), amount: 20_000 },
      { component: comp('3901'), amount: 50_000, directive: { id: 'd1', number: '1234567', paye: 9_000 } },
    ]);
    expect(l.payeSplit).toEqual({ regular: 2115, annualPayment: 0, directive: 9000 });
    expect(l.paye.monthlyPaye).toBe(11_115);
    expect(l.netPay).toBe(70_000 - 11_115);
    expect(l.validationResults).toEqual([]);
    const item = l.componentBreakdown.find(c => c.sarsSourceCode === '3901');
    expect(item?.directive).toEqual({ id: 'd1', number: '1234567', paye: 9_000 });
  });
});

describe('P3: taxable deductions and the split', () => {
  it('a taxable deduction larger than regular pay comes off the annual payment', () => {
    // Regular 5 000 − 8 000 deduction → 0; the 3 000 excess comes off the 130 000 bonus.
    // tax(127 000) = 22 860 − 17 820 = 5 040.
    const l = line([
      { component: comp('3601'), amount: 5_000 },
      { component: comp('4001', { componentType: 'deduction' }), amount: 8_000 },
      { component: comp('3605'), amount: 130_000 },
    ]);
    expect(l.payeSplit).toEqual({ regular: 0, annualPayment: 5040, directive: 0 });
    expect(l.taxableIncome).toBe(127_000);
  });
});

describe('P3: a leaver paid after leaving earns no ETI', () => {
  // 23 years old, R5 000, in the second 12 months employed (from January 2025):
  // the April 2025 table gives R750 (etiTables.ts).
  const young = {
    id: 'emp-2', dateOfBirth: new Date(2003, 0, 1), startDate: new Date(2025, 0, 1),
    uifExcluded: false, medicalAidMainMember: false, medicalAidDependantsCount: 0,
  } as unknown as PayrollEmployee;
  const severance: EmployeeComponent = {
    component: comp('3901'), amount: 5_000, directive: { id: 'd2', number: '1', paye: 0 },
  };
  const run = (notEmployedInPeriod: boolean) => calculatePayrollLine({
    employee: young, components: [severance], period: { month: 6, year: 2026 }, taxYear: 2027,
    annualPayrollEstimate: 'defer', notEmployedInPeriod,
  });

  it('is employed in the month: ETI as the table gives it', () => {
    expect(run(false).eti.monthlyEti).toBe(750);
  });

  it('is not employed in the month: nil, and says so', () => {
    const eti = run(true).eti;
    expect(eti.monthlyEti).toBe(0);
    expect(eti.isEligible).toBe(false);
    expect(eti.ineligibilityReason).toMatch(/Not employed/);
  });
});

describe('P3: SARS codes are classified after stripping ASCII space, tab, CR and LF only', () => {
  it('strips exactly the set the SQL readers strip', () => {
    expect(normaliseSarsCode(' 3901\t')).toBe('3901');
    expect(normaliseSarsCode('\r\n3605 ')).toBe('3605');
    expect(normaliseSarsCode('3901\u00a0')).toBe('3901\u00a0');
  });

  it("a padded lump-sum code is a lump sum; one padded with anything else is periodic, on both sides", () => {
    expect(payeTreatment('3901\t')).toBe('lump_sum');
    expect(payeTreatment(' 3605')).toBe('annual');
    expect(payeTreatment('3901\u00a0')).toBe('periodic');
  });
});
