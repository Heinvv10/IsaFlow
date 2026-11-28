/**
 * Wave 7 GT (W11; rulings 6, 15; grill F12): a garnishee order on an off-cycle termination run attaches to the leave
 * pay-out and notice pay (3605) only, never severance (3901) or a retirement lump sum (39xx); one instalment per order
 * the month's other final run did not take; emoluments attachments within 25% of that base, maintenance first and
 * uncapped; never above the balance; GARNISHEE_ON_TERMINATION names order, amount and remainder.
 * [Magistrates' Courts Act 32 of 1944 s61 ('emoluments'), s65J(1)(b)(i), s65J(1A)(a); Maintenance Act 99 of 1998 s1
 * ('emoluments'), s28(1), s29(3)]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatMoney } from '@/lib/money/formatMoney';
import { applyGarnishees, type GarnisheeOrderInput } from '@/modules/accounting/services/payroll/payrollGarnishee';
import {
  GARNISHEE_ON_TERMINATION, GARNISHEE_TAKEN_THIS_MONTH, terminationAttachableBaseOf,
} from '@/modules/accounting/services/payroll/payrollGarnisheeTermination';
import { calculatePayrollLine } from '@/modules/accounting/services/payroll/payrollCalculator';
import type { EmployeeComponent, PayrollEmployee } from '@/modules/accounting/services/payroll/payrollTypes';
import { buildCaseInput, ORACLE_DIR, type OracleCase } from '../../../fixtures/payroll-oracle/oracle';

const comp = (code: string, amount: number, name = code): EmployeeComponent => ({
  component: { id: `c-${code}-${name}`, name, sarsSourceCode: code, componentType: 'earning', isTaxable: true, isUifApplicable: false, isSdlApplicable: false },
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

const leave = comp('3605', 10000, 'Leave Pay-Out (Termination)');
const notice = comp('3605', 10000, 'Notice Pay (Termination)');
const severance = comp('3901', 50000, 'Severance Pay');

describe('terminationAttachableBaseOf', () => {
  it('is the leave pay-out and notice pay (3605), never severance 3901 or a 39xx lump sum', () => {
    expect(terminationAttachableBaseOf([leave, notice, severance, comp('3915', 80000)])).toBe(20000);
  });
});

describe('applyGarnishees on a termination line', () => {
  it('caps attachments at 25% of leave + notice pay; severance does not raise the base (ruling 15)', () => {
    const r = applyGarnishees({ orders: [order({ instalment: 5000 })], components: [leave, severance], netPayBefore: 57807.96,
      termination: { directivePaye: 0 } });
    expect(r.deductions.map((d) => [d.requested, d.amount])).toEqual([[5000, 2500]]);
    expect(r.warnings.map((w) => w.code)).toEqual(['GARNISHEE_LIMIT_APPLIED', GARNISHEE_ON_TERMINATION]);
  });

  it('maintenance is taken first and outside the 25% (Maintenance Act s28(1), s29(3))', () => {
    const r = applyGarnishees({
      orders: [order({ instalment: 6000, priority: 1 }), order({ kind: 'maintenance', instalment: 8000, priority: 999 })],
      components: [leave, notice], netPayBefore: 15600, termination: { directivePaye: 0 },
    });
    expect(r.deductions.map((d) => [d.kind, d.amount])).toEqual([['maintenance', 8000], ['emolument_attachment', 5000]]);
    expect(r.total).toBe(13000);
  });

  it('never above the order balance; the warning names the order, the amount and the remainder', () => {
    const r = applyGarnishees({ orders: [order({ instalment: 5000, balance: 1800, reference: 'EAO-1' })], components: [leave],
      netPayBefore: 7807.96, termination: { directivePaye: 0 } });
    expect(r.total).toBe(1800);
    const w = r.warnings.find((x) => x.code === GARNISHEE_ON_TERMINATION)!;
    expect(w.severity).toBe('warning');
    expect(w.message).toContain('EAO-1');
    expect(w.message).toContain(formatMoney(1800));
    expect(w.message).toContain(`${formatMoney(0)} is still owed`);
  });

  it('names what an order still owes after the termination run, or that it has no total', () => {
    const r = applyGarnishees({
      orders: [order({ instalment: 2000, balance: 9000, reference: 'EAO-2' }), order({ kind: 'maintenance', instalment: 1000, reference: 'MO-3' })],
      components: [leave], netPayBefore: 7807.96, termination: { directivePaye: 0 },
    });
    const msgs = r.warnings.filter((x) => x.code === GARNISHEE_ON_TERMINATION).map((x) => x.message);
    expect(msgs.find((m) => m.includes('EAO-2'))).toContain(`${formatMoney(7000)} is still owed`);
    expect(msgs.find((m) => m.includes('MO-3'))).toMatch(/no total debt/);
  });

  it('the pay left is what leave + notice pay net: severance less its own directive PAYE is never taken (breaker #1939 H1)', () => {
    // Leave 10 000 taxed 2 192.04 on the tables; severance 50 000 with directive PAYE 0 (the tax-free R550 000 band):
    // net before 57 807.96; severance nets 50 000, so the orders may take 7 807.96 and no more, not even maintenance.
    const r = applyGarnishees({ orders: [order({ kind: 'maintenance', instalment: 9000 })], components: [leave, severance],
      netPayBefore: 57807.96, termination: { directivePaye: 0 } });
    expect(r.total).toBe(7807.96);
    expect(r.warnings.map((w) => w.code)).toContain('GARNISHEE_SHORTFALL');
    // Maintenance 6 000 first, then an attachment of 2 500 (25% cap): only 1 807.96 is left for the attachment.
    const two = applyGarnishees({ orders: [order({ kind: 'maintenance', instalment: 6000 }), order({ instalment: 2500 })],
      components: [leave, severance], netPayBefore: 57807.96, termination: { directivePaye: 0 } });
    expect(two.deductions.map((d) => d.amount)).toEqual([6000, 1807.96]);
  });

  it('a severance taxed by its directive keeps only its own net out: the directive PAYE is the severance\'s, not leave pay\'s', () => {
    // Severance 50 000 with directive PAYE 9 000: it nets 41 000. Net before 48 807.96 = 57 807.96 - 9 000; pay left 7 807.96.
    const r = applyGarnishees({ orders: [order({ kind: 'maintenance', instalment: 9000 })], components: [leave, severance],
      netPayBefore: 48807.96, termination: { directivePaye: 9000 } });
    expect(r.total).toBe(7807.96);
  });

  it('a line with no leave or notice pay attaches nothing (a severance-only termination line)', () => {
    const r = applyGarnishees({ orders: [order({ kind: 'maintenance', instalment: 5000 })], components: [severance],
      netPayBefore: 50000, termination: { directivePaye: 0 } });
    expect(r.total).toBe(0);
  });

  it('one instalment, never a part-month warning: a termination run takes the instalment once', () => {
    const r = applyGarnishees({ orders: [order({ instalment: 1000, partMonth: true })], components: [leave],
      netPayBefore: 7807.96, termination: { directivePaye: 0 } });
    expect(r.total).toBe(1000);
    expect(r.warnings.map((w) => w.code)).toEqual([GARNISHEE_ON_TERMINATION]);
  });
});

describe('an order the month\'s other final run took (grill F12, both ways)', () => {
  it('a termination line skips it and says so (info, naming the order id)', () => {
    const taken = order({ instalment: 1000, takenThisMonth: true });
    const r = applyGarnishees({ orders: [taken], components: [leave], netPayBefore: 7807.96, termination: { directivePaye: 0 } });
    expect(r.deductions).toEqual([]);
    expect(r.warnings).toEqual([expect.objectContaining({ code: GARNISHEE_TAKEN_THIS_MONTH, severity: 'info', orders: [taken.id] })]);
  });

  it('a regular line skips an order the month\'s final termination run took', () => {
    const taken = order({ instalment: 1000, takenThisMonth: true });
    const other = order({ instalment: 500 });
    const r = applyGarnishees({ orders: [taken, other], components: [comp('3601', 20000)], netPayBefore: 17707.88 });
    expect(r.deductions.map((d) => d.orderId)).toEqual([other.id]);
    expect(r.warnings.find((w) => w.code === GARNISHEE_TAKEN_THIS_MONTH)!.message).toMatch(/termination run/);
  });
});

describe('calculatePayrollLine with garnisheeTermination', () => {
  const employee: PayrollEmployee = {
    id: 'e1', companyId: 'c1', employeeNumber: 'E1', firstName: 'A', lastName: 'B', employmentType: 'permanent',
    startDate: new Date(2020, 2, 1), dateOfBirth: new Date(1986, 0, 1), taxStatus: 'employee', uifExcluded: false,
    medicalAidMainMember: false, medicalAidDependantsCount: 0, s18aReceiptHeld: false, payBasis: 'monthly',
  } as PayrollEmployee;

  it('takes the 25% of the leave pay, not of a nil basic salary, and nets it off the line', () => {
    const base = { employee, components: [leave], period: { year: 2026, month: 6 }, taxYear: 2027, annualPayrollEstimate: 10_000_000 as const };
    const without = calculatePayrollLine(base);
    const line = calculatePayrollLine({ ...base, garnisheeOrders: [order({ instalment: 5000 })], garnisheeTermination: true });
    expect(line.garnishees.map((g) => g.amount)).toEqual([2500]);
    expect(line.netPay).toBe(Math.round((without.netPay - 2500) * 100) / 100);
    // Without the flag the regular rule applies: a nil 3601 basic salary leaves no room for an attachment.
    expect(calculatePayrollLine({ ...base, garnisheeOrders: [order({ instalment: 5000 })] }).garnishees.map((g) => g.amount)).toEqual([0]);
  });
});

describe('breaker #1939 REPRO 1 (ported): severance is never garnished on the stored line', () => {
  const load = (id: string) => JSON.parse(readFileSync(join(ORACLE_DIR, `${id}.json`), 'utf8')) as OracleCase;
  const withOrders = (c: OracleCase, orders: unknown[]): OracleCase =>
    ({ ...c, input: { ...c.input, unmodelled: { ...c.input.unmodelled, garnisheeOrders: orders } } } as OracleCase);
  const c = load('termination-garnishee-severance-excluded');
  const none = calculatePayrollLine(buildCaseInput(withOrders(c, [])));
  // All the line's PAYE and UIF are the leave pay's: the 3901 has no directive here, so it carries none.
  const leaveNet = Math.round((10000 - none.paye.monthlyPaye - none.uif.employeeContribution) * 100) / 100;
  const took = (orders: unknown[]) => calculatePayrollLine(buildCaseInput(withOrders(c, orders))).garnishees.reduce((t, g) => t + g.amount, 0);

  it('maintenance of R9 000 takes only what the leave pay nets', () => {
    expect(took([{ kind: 'maintenance', monthlyAmount: 9000 }])).toBeCloseTo(leaveNet, 2);
  });

  it('maintenance R6 000 + an attachment R2 500 together stay within the leave pay\'s net', () => {
    expect(took([{ kind: 'maintenance', monthlyAmount: 6000 }, { kind: 'emolument_attachment', monthlyAmount: 2500 }])).toBeCloseTo(leaveNet, 2);
  });

  it('a severance-only line attaches nothing', () => {
    const x = { ...c, input: { ...c.input, components: c.input.components.filter((k) => k.code === '3901') } } as OracleCase;
    expect(calculatePayrollLine(buildCaseInput(withOrders(x, [{ kind: 'maintenance', monthlyAmount: 9000 }]))).garnishees
      .reduce((t, g) => t + g.amount, 0)).toBe(0);
  });
});
