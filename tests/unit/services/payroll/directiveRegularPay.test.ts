/**
 * calculatePayrollLine with an IRP3(b) fixed-percentage or IRP3(c) fixed-amount directive on regular pay (wave 5 DR).
 * Sources: PAYE-GEN-01-G21 (2027) Rev 1 p. 15 (the percentage applies before allowable deductions; no deviation; valid
 * for the period stated), p. 16 (IRP3(b), IRP3(c)), p. 17 (Fourth Schedule para 11), p. 28 (a directive for a
 * non-standard employee decides), p. 12 (SDL after para 2(4) deductions).
 */
import { describe, expect, it } from 'vitest';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import type { RegularPayDirective, RegularPayDirectiveState } from '@/modules/accounting/services/payroll/directiveRegularPay';
import type { EmployeeComponent, PayeYearToDate, PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';

const employee = (o: Partial<PayrollEmployee> = {}): PayrollEmployee => ({
  id: 'e1', companyId: 'c', employeeNumber: '1', firstName: 'A', lastName: 'B', employmentType: 'permanent',
  startDate: new Date(2020, 2, 1), dateOfBirth: new Date(1986, 0, 1), uifExcluded: false, medicalAidMainMember: false,
  medicalAidDependantsCount: 0, s18aReceiptHeld: false, taxStatus: 'employee', payBasis: 'monthly', ...o,
});
const earn = (amount: number, code = '3601'): EmployeeComponent => ({
  component: { id: `c-${code}`, name: 'Pay', sarsSourceCode: code, componentType: 'earning', isTaxable: true, isUifApplicable: true, isSdlApplicable: true }, amount,
});
const ra = (amount: number): EmployeeComponent => ({
  component: { id: 'd-4006', name: 'RA', sarsSourceCode: '4006', componentType: 'deduction', isTaxable: true, isUifApplicable: false, isSdlApplicable: false }, amount,
});
const pct20: RegularPayDirective = { id: 'd-20', number: '1234567', type: 'fixed_percentage', rate: 0.2, fixedAmount: null, endsOn: '2027-02-28' };
const fixed2500: RegularPayDirective = { id: 'd-fa', number: '7654321', type: 'fixed_amount', rate: null, fixedAmount: 2_500, endsOn: '2027-02-28' };
const state = (current: RegularPayDirective | null, ended: RegularPayDirective | null = null): RegularPayDirectiveState => ({ current, ended });
const cost = (e: PayrollEmployee, components: EmployeeComponent[], directive?: RegularPayDirectiveState, ytd?: PayeYearToDate) => calculatePayrollLine({
  employee: e, components, period: { year: 2026, month: 3 }, taxYear: 2027, annualPayrollEstimate: 1_000_000, ytd, regularPayDirective: directive,
});
const codes = (r: ReturnType<typeof cost>) => r.validationResults.map(v => v.code);
const outside = (r: ReturnType<typeof cost>) => r.validationResults.filter(v => v.code === 'PAYE_OUTSIDE_TABLES');
const YTD: PayeYearToDate = { periods: 5, periodicTaxable: 150_000, annualPayments: 0, tablePaye: 23_405, medicalCredit: 0, additionalMedicalCredit: 0, medicalSchemeFees: 0,
  sdlApplicable: 0, sdlLeviable: 0, sdlRetirementDeduction: 0 };

describe('IRP3(b) fixed percentage on regular pay (G21 p. 15-16)', () => {
  it('20% of R30 000 is R6 000.00 (the tables give R4 681.00); UIF 177.12, SDL 300, net 23 822.88', () => {
    expect(cost(employee(), [earn(30_000)]).paye.monthlyPaye).toBe(4_681);
    const r = cost(employee(), [earn(30_000)], state(pct20));
    expect([r.paye.monthlyPaye, r.payeSplit.regular, r.uif.employeeContribution, r.sdl, r.netPay]).toEqual([6_000, 6_000, 177.12, 300, 23_822.88]);
    expect(outside(r)).toEqual([expect.objectContaining({ severity: 'info', treatment: 'directive', directive: expect.objectContaining({ id: 'd-20', rate: 0.2 }) })]);
  });
  it('the RA does not reduce the base (G21 p. 15): R6 000.00 with R3 000 RA; SDL is after it (R270, G21 p. 12)', () => {
    const r = cost(employee(), [earn(30_000), ra(3_000)], state(pct20));
    expect([r.paye.monthlyPaye, r.sdl, r.netPay]).toEqual([6_000, 270, 20_822.88]);
  });
  it('the year to date does not move it, and no medical credit is given against it', () => {
    const r = cost(employee({ medicalAidMainMember: true }), [earn(30_000)], state(pct20), YTD);
    expect([r.paye.monthlyPaye, r.medicalCredit]).toEqual([6_000, 0]);
  });
  it('a 3605 bonus is taxed by the tables beside it, with an UNVERIFIED warning', () => {
    const r = cost(employee(), [earn(30_000), earn(10_000, '3605')], state(pct20));
    expect(r.payeSplit.regular).toBe(6_000);
    expect(r.payeSplit.annualPayment).toBeGreaterThan(0);
    expect(r.paye.monthlyPaye).toBe(6_000 + r.payeSplit.annualPayment);
    expect(codes(r)).toContain('DIRECTIVE_ANNUAL_PAYMENT_ON_TABLES');
  });
});

describe('IRP3(c) fixed amount (G21 p. 16-17)', () => {
  it('R2 500.00 on R30 000 whatever the tables say; net 27 322.88; per-period reading warned UNVERIFIED', () => {
    const r = cost(employee(), [earn(30_000)], state(fixed2500));
    expect([r.paye.monthlyPaye, r.sdl, r.netPay]).toEqual([2_500, 300, 27_322.88]);
    expect(codes(r)).toContain('DIRECTIVE_FIXED_AMOUNT_PER_PERIOD');
  });
  it('nil when no regular pay is paid this period', () => {
    expect(cost(employee(), [earn(10_000, '3605')], state(fixed2500)).payeSplit.regular).toBe(0);
  });
});

describe('a directive overrides the tax-status treatment (G21 p. 28-29)', () => {
  const FLAT = { payBasis: 'daily' as const, hoursPerWeek: 14, hoursPerDay: 6, dailyRate: 500 };
  it('non-standard at a flat 25% (R1 250 on R5 000) under a 20% directive: R1 000, and no flat-rate result', () => {
    expect(cost(employee(FLAT), [earn(5_000)]).paye.monthlyPaye).toBe(1_250);
    const r = cost(employee(FLAT), [earn(5_000)], state(pct20));
    expect(r.paye.monthlyPaye).toBe(1_000);
    expect(outside(r).map(v => v.treatment)).toEqual(['directive']);
  });
  it('an independent contractor: PAYE as directed, UIF and SDL still nil, the contractor flag kept and a warning', () => {
    const r = cost(employee({ taxStatus: 'independent_contractor' }), [earn(30_000)], state(pct20));
    expect([r.paye.monthlyPaye, r.uif.employeeContribution, r.sdl]).toEqual([6_000, 0, 0]);
    expect(outside(r).map(v => v.treatment).sort()).toEqual(['directive', 'none']);
    expect(codes(r)).toContain('DIRECTIVE_FOR_CONTRACTOR');
  });
});

describe('the line names the directive by its number, never by its row id', () => {
  it('a number: "SARS directive 1234567"; none or blank: "the SARS directive"', () => {
    const message = (d: RegularPayDirective) => outside(cost(employee(), [earn(30_000)], state(d)))[0]!.message;
    expect(message(pct20)).toMatch(/is SARS directive 1234567: 20%/);
    for (const number of [null, '', '  ']) {
      expect(message({ ...pct20, number })).toMatch(/is the SARS directive: 20%/);
      expect(message({ ...pct20, number })).not.toContain('d-20');
    }
  });
});

describe('after the directive ends (G21 p. 15: valid only for the period stated)', () => {
  it('the tables apply again, with an UNVERIFIED warning on the first month', () => {
    const r = cost(employee(), [earn(30_000)], state(null, pct20));
    expect(r.paye.monthlyPaye).toBe(4_681);
    expect(outside(r)).toEqual([]);
    expect(codes(r)).toContain('DIRECTIVE_ENDED');
  });
  it('no directive at all: no directive result', () => {
    const r = cost(employee(), [earn(30_000)], state(null));
    expect(codes(r).filter(c => c.startsWith('DIRECTIVE') || c === 'PAYE_OUTSIDE_TABLES')).toEqual([]);
  });
});
