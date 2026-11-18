/**
 * Garnishee orders on a pay line (wave 6 GA): the s65J(1A)(a) 25% limit on emoluments attachment orders, maintenance
 * outside it and first (Maintenance Act s28(1), s29(3)), net pay never below nil, balance as a ceiling.
 * [Magistrates' Courts Act 32 of 1944 s65J(1A)(a)-(b) as substituted by Act 7 of 2017; Maintenance Act 99 of 1998 s28, s29(3)]
 */
import { describe, expect, it } from 'vitest';
import {
  applyGarnishees, basicSalaryOf, orderGarnishees, type GarnisheeOrderInput,
} from '@/modules/accounting/services/payroll/payrollGarnishee';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import { judgeLoanApplications } from '@/modules/accounting/services/payroll/payrollRunLoanDecision';
import type { EmployeeComponent, PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';

const comp = (code: string, amount: number, type: 'earning' | 'deduction' = 'earning'): EmployeeComponent => ({
  component: { id: `c-${code}-${amount}`, name: code, sarsSourceCode: code, componentType: type, isTaxable: true, isUifApplicable: true, isSdlApplicable: true },
  amount,
} as EmployeeComponent);

let seq = 0;
const order = (o: Partial<GarnisheeOrderInput>): GarnisheeOrderInput => {
  seq += 1;
  return {
    id: `o-${seq}`, kind: 'emolument_attachment', reference: `CASE-${seq}`, creditorName: 'Creditor', instalment: 1000,
    balance: null, priority: 100, createdAt: `2026-01-0${(seq % 9) + 1}T00:00:00Z`, ...o,
  };
};

const salary = [comp('3601', 20000)];

describe('applyGarnishees', () => {
  it('caps emoluments attachment orders at 25% of basic salary [s65J(1A)(a)]', () => {
    const r = applyGarnishees({ orders: [order({ instalment: 6000 })], components: salary, netPayBefore: 17707.88 });
    expect(r.deductions.map((d) => [d.requested, d.amount])).toEqual([[6000, 5000]]);
    expect(r.total).toBe(5000);
    expect(r.warnings.map((w) => w.code)).toEqual(['GARNISHEE_LIMIT_APPLIED']);
  });

  it('the 25% is shared by every attachment order, in priority order', () => {
    const r = applyGarnishees({
      orders: [order({ instalment: 3000, priority: 2 }), order({ instalment: 4000, priority: 1 })],
      components: salary, netPayBefore: 17707.88,
    });
    expect(r.deductions.map((d) => [d.requested, d.amount])).toEqual([[4000, 4000], [3000, 1000]]);
  });

  it('maintenance is outside the limit and taken first [Maintenance Act s28(1), s29(3)]', () => {
    const r = applyGarnishees({
      orders: [order({ instalment: 5000 }), order({ kind: 'maintenance', instalment: 4000, priority: 999 })],
      components: salary, netPayBefore: 17707.88,
    });
    expect(r.deductions.map((d) => [d.kind, d.amount])).toEqual([['maintenance', 4000], ['emolument_attachment', 5000]]);
    expect(r.total).toBe(9000);
    expect(r.warnings).toEqual([]);
  });

  it('named limit: commission is outside the base, and a line with an attachment and commission says so (rev #1574 L1)', () => {
    const r = applyGarnishees({ orders: [order({ instalment: 2000 })], components: [comp('3606', 30000)], netPayBefore: 24000 });
    expect(r.total).toBe(0);
    expect(r.warnings.map((w) => w.code)).toContain('GARNISHEE_BASE_EXCLUDES_COMMISSION');
    expect(r.warnings.find((w) => w.code === 'GARNISHEE_BASE_EXCLUDES_COMMISSION')!.message).toMatch(/^garnishee base excludes commission \(UNVERIFIED vs s65J\(1A\)\(b\)\)/);
    const plain = applyGarnishees({ orders: [order({ instalment: 2000 })], components: salary, netPayBefore: 17707.88 });
    expect(plain.warnings.map((w) => w.code)).not.toContain('GARNISHEE_BASE_EXCLUDES_COMMISSION');
    const maintenanceOnly = applyGarnishees({ orders: [order({ kind: 'maintenance', instalment: 2000 })], components: [comp('3606', 30000)], netPayBefore: 24000 });
    expect(maintenanceOnly.warnings.map((w) => w.code)).not.toContain('GARNISHEE_BASE_EXCLUDES_COMMISSION');
  });

  it('named limit: a part-month order still takes its full instalment, and the line says so (breaker round 2)', () => {
    const r = applyGarnishees({ orders: [order({ kind: 'maintenance', instalment: 900, partMonth: true })], components: salary, netPayBefore: 17707.88 });
    expect(r.total).toBe(900);
    const w = r.warnings.find((x) => x.code === 'GARNISHEE_PART_MONTH');
    expect(w?.message).toMatch(/^full monthly instalment charged for a part-month order \(named limit\)/);
    const whole = applyGarnishees({ orders: [order({ kind: 'maintenance', instalment: 900 })], components: salary, netPayBefore: 17707.88 });
    expect(whole.warnings.map((x) => x.code)).not.toContain('GARNISHEE_PART_MONTH');
  });

  it('basic salary excludes overtime and allowances [s65J(1A)(b)]', () => {
    expect(basicSalaryOf([comp('3601', 10000), comp('3607', 4000), comp('3701', 2000), comp('4001', 500, 'deduction')])).toBe(10000);
    const r = applyGarnishees({ orders: [order({ instalment: 3000 })], components: [comp('3601', 10000), comp('3607', 4000)], netPayBefore: 12000 });
    expect(r.total).toBe(2500);
  });

  it('net pay is never below nil: a shortfall is a named warning', () => {
    const r = applyGarnishees({ orders: [order({ kind: 'maintenance', instalment: 3000 })], components: salary, netPayBefore: 1200.5 });
    expect(r.deductions.map((d) => d.amount)).toEqual([1200.5]);
    expect(r.warnings.map((w) => w.code)).toEqual(['GARNISHEE_SHORTFALL']);
    const nil = applyGarnishees({ orders: [order({ kind: 'maintenance', instalment: 3000 })], components: salary, netPayBefore: -50 });
    expect(nil.total).toBe(0);
  });

  it('the balance owed caps the instalment; a nil balance takes nothing', () => {
    const r = applyGarnishees({
      orders: [order({ instalment: 2000, balance: 750.25 }), order({ instalment: 2000, balance: 0 })],
      components: salary, netPayBefore: 17707.88,
    });
    expect(r.deductions.map((d) => d.amount)).toEqual([750.25]);
  });

  it('an administration order is outside the limit and carries the unverified caution', () => {
    const r = applyGarnishees({ orders: [order({ kind: 'administration', instalment: 8000 })], components: salary, netPayBefore: 17707.88 });
    expect(r.total).toBe(8000);
    expect(r.warnings.map((w) => w.code)).toEqual(['GARNISHEE_ADMINISTRATION_UNVERIFIED']);
  });

  it('no orders: nothing taken', () => {
    expect(applyGarnishees({ orders: [], components: salary, netPayBefore: 100 })).toEqual({ deductions: [], total: 0, warnings: [] });
  });

  it('orders: maintenance, then priority, then oldest', () => {
    const a = order({ priority: 1, createdAt: '2026-02-01' });
    const b = order({ priority: 1, createdAt: '2026-01-01' });
    const m = order({ kind: 'maintenance', priority: 50 });
    expect(orderGarnishees([a, b, m]).map((o) => o.id)).toEqual([m.id, b.id, a.id]);
  });
});

describe('the calculator and the loan preview cost the same garnishee orders (payrollRunLoanDecision, rule 5)', () => {
  const employee: PayrollEmployee = {
    id: 'e1', companyId: 'c', employeeNumber: '1', firstName: 'A', lastName: 'B', employmentType: 'permanent',
    startDate: new Date(2020, 2, 1), dateOfBirth: new Date(1986, 0, 1), uifExcluded: false, medicalAidMainMember: false,
    medicalAidDependantsCount: 0, s18aReceiptHeld: false, taxStatus: 'employee', payBasis: 'monthly',
  };
  const orders = [order({ instalment: 6000 }), order({ kind: 'maintenance', instalment: 4000 })];
  const app = (amount: number) => ({ loanId: 'l', loanNumber: 'L1', employeeId: 'e1', scheduleRowId: 's', interest: 0, principal: amount,
    installment: amount, fringeBenefit: 0, openingBalance: amount, closingBalance: 0 });
  const judge = (amount: number) => judgeLoanApplications({
    basis: { employee, components: salary }, applications: [app(amount)], loanComponents: { deduction: null, fringe: null },
    period: { year: 2026, month: 3 }, taxYear: 2027, garnisheeOrders: orders,
  });

  it('the stored line: PAYE and UIF unchanged by the orders, net after them', () => {
    const base = { employee, components: salary, period: { year: 2026, month: 3 }, taxYear: 2027, annualPayrollEstimate: 10_000_000 };
    const without = calculatePayrollLine(base);
    const withOrders = calculatePayrollLine({ ...base, garnisheeOrders: orders });
    expect(withOrders.paye.monthlyPaye).toBe(without.paye.monthlyPaye);
    expect(withOrders.uif).toEqual(without.uif);
    expect(withOrders.netPay).toBe(Math.round((without.netPay - 9000) * 100) / 100);
    expect(withOrders.garnishees.map((g) => g.amount)).toEqual([4000, 5000]);
  });

  it('the preview judges a loan on the pay left after the orders: the court orders come first', () => {
    const left = calculatePayrollLine({ employee, components: salary, period: { year: 2026, month: 3 }, taxYear: 2027,
      annualPayrollEstimate: 'defer', garnisheeOrders: orders }).netPay;
    expect(judge(left)).toEqual({ allowed: true, rawNet: 0 });
    expect(judge(left + 0.01)).toEqual({ allowed: false, rawNet: -0.01 });
  });
});
