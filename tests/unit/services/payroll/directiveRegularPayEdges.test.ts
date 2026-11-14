/**
 * Regular-pay directives (wave 5 DR), round 1 edges: the clawback base, the cap at the cash paid, rounding, the run's
 * reading (partial month, overlap, unusable row) and the loan preview. Sources: G21 (2027) Rev 1 p. 15 (before
 * allowable deductions; no deviation), p. 16-17 (IRP3(b)/(c); tax deducted "from the remuneration"), p. 12 (SDL).
 * Repros R1/R2 are the adversarial reviewer's (#1266 round 1, A-M1 / A-M2).
 */
import { describe, expect, it } from 'vitest';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import { judgeLoanApplications } from '@/modules/accounting/services/payroll/payrollRunLoanDecision';
import type { RegularPayDirective, RegularPayDirectiveState } from '@/modules/accounting/services/payroll/directiveRegularPay';
import type { EmployeeComponent, PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';

const employee: PayrollEmployee = {
  id: 'e1', companyId: 'c', employeeNumber: '1', firstName: 'A', lastName: 'B', employmentType: 'permanent',
  startDate: new Date(2020, 2, 1), dateOfBirth: new Date(1986, 0, 1), uifExcluded: false, medicalAidMainMember: false,
  medicalAidDependantsCount: 0, s18aReceiptHeld: false, taxStatus: 'employee', payBasis: 'monthly',
};
const earn = (amount: number, code = '3601'): EmployeeComponent => ({
  component: { id: `c-${code}`, name: 'Pay', sarsSourceCode: code, componentType: 'earning', isTaxable: true, isUifApplicable: true, isSdlApplicable: true }, amount,
});
const ra = (amount: number): EmployeeComponent => ({
  component: { id: 'd-4006', name: 'RA', sarsSourceCode: '4006', componentType: 'deduction', isTaxable: true, isUifApplicable: false, isSdlApplicable: false }, amount,
});
const window = { endsOn: '2027-02-28', effectiveDate: '2026-03-01' };
const pct = (rate: number): RegularPayDirective => ({ id: 'd-p', number: '1234567', type: 'fixed_percentage', rate, fixedAmount: null, ...window });
const fixed = (amount: number): RegularPayDirective => ({ id: 'd-fa', number: '7654321', type: 'fixed_amount', rate: null, fixedAmount: amount, ...window });
const state = (current: RegularPayDirective | null, extra: Partial<RegularPayDirectiveState> = {}): RegularPayDirectiveState => ({ current, ended: null, ...extra });
const cost = (components: EmployeeComponent[], d?: RegularPayDirectiveState) => calculatePayrollLine({
  employee, components, period: { year: 2026, month: 8 }, taxYear: 2027, annualPayrollEstimate: 1_000_000, regularPayDirective: d,
});
const codes = (r: ReturnType<typeof cost>) => r.validationResults.map(v => v.code);

describe('the base: the month\'s remuneration before para 2(4) deductions, a clawback netted in', () => {
  it('R1: R30 000 with a R5 000 3605 clawback is R25 000: 20% = R5 000.00', () => {
    const r = cost([earn(30_000), earn(-5_000, '3605')], state(pct(0.2)));
    expect(r.taxableIncome).toBe(25_000);
    expect(r.paye.monthlyPaye).toBe(5_000);
  });
  it('a clawback larger than the pay leaves a nil base: no PAYE', () => {
    expect(cost([earn(1_000), earn(-5_000, '3605')], state(pct(0.2))).paye.monthlyPaye).toBe(0);
  });
  it('rounding: 17.5% of R30 000.55 = 5 250.09625 -> R5 250.10 on the regular split', () => {
    expect(cost([earn(30_000.55)], state(pct(0.175))).payeSplit.regular).toBe(5_250.1);
  });
  it('a fixed amount with an RA: R2 500.00 as directed; SDL after the RA (R270); net 24 322.88', () => {
    const r = cost([earn(30_000), ra(3_000)], state(fixed(2_500)));
    expect([r.paye.monthlyPaye, r.sdl, r.netPay]).toEqual([2_500, 270, 24_322.88]);
  });
});

describe('the cap: tax is deducted from the remuneration (G21 p. 17)', () => {
  it('R2: R2 500 fixed on a R1 000 month withholds R990 (R1 000 less R10 UIF), names the R1 510 shortfall, no overdraw', () => {
    const r = cost([earn(1_000)], state(fixed(2_500)));
    expect([r.paye.monthlyPaye, r.netPay]).toEqual([990, 0]);
    expect(codes(r)).toContain('DIRECTIVE_PAYE_CAPPED');
    expect(codes(r)).not.toContain('DEDUCTIONS_EXCEED_PAY');
    expect(r.validationResults.find(v => v.code === 'DIRECTIVE_PAYE_CAPPED')?.message).toMatch(/R.1.510\.00 was not/);
  });
  it('under the cash: no cap, no warning', () => {
    expect(codes(cost([earn(30_000)], state(fixed(2_500))))).not.toContain('DIRECTIVE_PAYE_CAPPED');
  });
});

describe('the run\'s reading reaches the line as warnings or errors, never silently', () => {
  it('a window inside the month, applied or not: DIRECTIVE_PARTIAL_PERIOD', () => {
    const d = { ...pct(0.2), effectiveDate: '2026-08-20', endsOn: '2026-08-25' };
    const r = cost([earn(30_000)], state(null, { partial: [{ directive: d, applied: false }] }));
    expect(r.paye.monthlyPaye).toBe(4_681);
    expect(r.validationResults.find(v => v.code === 'DIRECTIVE_PARTIAL_PERIOD')?.message).toMatch(/not in force on the pay date/);
  });
  it('two in force: DIRECTIVE_OVERLAP error, the tables apply', () => {
    const r = cost([earn(30_000)], state(null, { overlapping: ['111', '222'] }));
    expect(r.validationResults.find(v => v.code === 'DIRECTIVE_OVERLAP')?.severity).toBe('error');
    expect(r.paye.monthlyPaye).toBe(4_681);
  });
  it('an unusable row: DIRECTIVE_INVALID error', () => {
    expect(cost([earn(30_000)], state(null, { invalid: ['333'] })).validationResults.find(v => v.code === 'DIRECTIVE_INVALID')?.severity).toBe('error');
  });
});

describe('the loan preview costs the line with the same directive (payrollRunLoanDecision)', () => {
  it('R24 000 of loan against R30 000 under 20%: net before the loan R23 822.88, so refused (R177.12 short)', () => {
    const decision = judgeLoanApplications({
      basis: { employee, components: [earn(30_000)], regularPayDirective: state(pct(0.2)) },
      applications: [{ loanId: 'l', loanNumber: 'L1', employeeId: 'e1', scheduleRowId: 's', interest: 0, principal: 24_000, installment: 24_000,
        fringeBenefit: 0, openingBalance: 24_000, closingBalance: 0 }],
      loanComponents: { deduction: null, fringe: null }, period: { year: 2026, month: 8 }, taxYear: 2027,
    });
    expect(decision).toEqual({ allowed: false, rawNet: -177.12 });
  });
});
