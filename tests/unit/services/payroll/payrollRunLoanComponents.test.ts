/**
 * appendLoanComponents puts a loan's repayment and fringe benefit on the payslip with the components
 * the run loaded once. A loan applied with nowhere to show it is refused, never skipped: skipping
 * reduced the loan with nothing deducted. The run withholds such a loan before applying it
 * (tests/integration/payrun-loan-components.int.test.ts); this is the backstop.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => { throw new Error('appendLoanComponents must not query'); }) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { appendLoanComponents } from '@/modules/accounting/services/payroll/payrollRunLoanComponents';
import type { PayrollComponent } from '@/modules/accounting/services/payroll/payrollTypes';
import type { ApplyLoanResult } from '@/modules/accounting/services/payroll/payrollLoanService';

const component = (id: string, sarsSourceCode: string, componentType: 'earning' | 'deduction'): PayrollComponent => ({
  id, name: id, sarsSourceCode, componentType, isTaxable: componentType === 'earning', isUifApplicable: false, isSdlApplicable: false,
});
const deduction = component('loan', 'LOAN', 'deduction');
const fringe = component('fringe', '3801', 'earning');
const applied = (over: Partial<ApplyLoanResult>): ApplyLoanResult => ({
  loanId: 'l1', loanNumber: 'R-LOAN', employeeId: 'e1', scheduleRowId: 's1', interest: 10, principal: 990, installment: 1000,
  fringeBenefit: 0, openingBalance: 1000, closingBalance: 0, ...over,
});

describe('appendLoanComponents', () => {
  it('adds the repayment as the LOAN deduction and the benefit as the 3801 earning', () => {
    expect(appendLoanComponents([], [applied({ fringeBenefit: 7.08 })], { deduction, fringe })).toEqual([
      { component: deduction, amount: 1000 }, { component: fringe, amount: 7.08 },
    ]);
  });

  it('nothing to add needs no component', () => {
    expect(appendLoanComponents([], [applied({ interest: 0, principal: 0 })], { deduction: null, fringe: null })).toEqual([]);
  });

  it('a repayment with no LOAN deduction is refused, naming the loan', () => {
    expect(() => appendLoanComponents([], [applied({})], { deduction: null, fringe })).toThrow(/R-LOAN/);
  });

  it('a benefit with no 3801 earning is refused, naming the loan', () => {
    expect(() => appendLoanComponents([], [applied({ fringeBenefit: 7.08 })], { deduction, fringe: null })).toThrow(/R-LOAN/);
  });
});
