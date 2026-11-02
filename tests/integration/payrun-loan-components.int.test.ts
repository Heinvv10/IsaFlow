/**
 * The loan service's payslip components, failing closed (master plan wave 3, R; breaker round):
 *  - setup-components counts only an active deduction coded LOAN and an active earning coded 3801;
 *  - a low-interest loan with no 3801 earning is collected; the line warns that its fringe benefit
 *    was not recorded (Hein). A loan with no LOAN deduction is not taken;
 *  - a withheld instalment is named at the amount the loan
 *    service would take, and the reversal log says why an instalment was not taken again.
 * Disposable fixture DB only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import setupComponents from '../../pages/api/payroll/loans/setup-components';
import componentsRoute from '../../pages/api/payroll/components';
import { log } from '../../src/lib/logger';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { inputsFixture } from './payrun-period-inputs.helpers';
import type { Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = inputsFixture(pool);
const { state, line, preview, recalculate, addLoan, addComponent, call } = fx;
const comp = state.comp;

beforeAll(fx.setUp);
beforeEach(fx.freshCompany);
afterEach(async () => { vi.restoreAllMocks(); await fx.dropCompany(); });
afterAll(fx.tearDown);

const loanState = async (loan: string) => ({
  balance: Number((await pool.query('SELECT outstanding_balance FROM payroll_loans WHERE id = $1', [loan])).rows[0]!.outstanding_balance),
  paidFlags: (await pool.query('SELECT paid_flag FROM payroll_loan_schedule WHERE loan_id = $1 ORDER BY sequence', [loan])).rows.map((r) => r.paid_flag),
  payments: Number((await pool.query('SELECT count(*) FROM payroll_loan_payments WHERE loan_id = $1', [loan])).rows[0]!.count),
});
const results = async () => (await line(state.nov)).validation_results as Array<{ code: string; message: string; severity: string }>;
const blocker = async () => (await preview(state.nov)).body.data!.blocker;
const lowInterest = async (instalment = 1000) => {
  const loan = await addLoan(instalment);
  await pool.query('UPDATE payroll_loans SET annual_interest_rate = 0 WHERE id = $1', [loan]);
  return loan;
};
const fringe = (code = '3801', type = 'earning') => addComponent(state.coA, 'Low-interest loan benefit', code, type, true);
const loanComponents = async () => (await pool.query(
  `SELECT sars_source_code AS code, component_type AS type, is_active AS active FROM payroll_components
    WHERE company_id = $1 AND BTRIM(sars_source_code) IN ('LOAN', '3801') ORDER BY created_at, id`, [state.coA])).rows;
const setUp = () => call(setupComponents as Route, 'POST', '/api/payroll/loans/setup-components', undefined);
const create = (body: Record<string, unknown>) => call(componentsRoute as Route, 'POST', '/api/payroll/components', undefined, { body });

describe('setup-components counts only what the run can use', () => {
  it('a company whose only LOAN component is an earning gets a LOAN deduction, and the run takes the instalment', async () => {
    await pool.query(`UPDATE payroll_components SET component_type = 'earning' WHERE id = $1`, [comp.loan]);
    const plain = await line(state.nov);
    const loan = await addLoan(1000);
    const res = await setUp();
    expect(res.body.data).toMatchObject({ created: ['LOAN', '3801'] });
    await recalculate(state.nov);
    expect((await line(state.nov)).net).toBeCloseTo(plain.net - 1000, 2);
    expect(await loanState(loan)).toMatchObject({ balance: 0, payments: 1 });
  });

  it('an inactive LOAN deduction or a 3801 deduction is not present; an active proper pair is', async () => {
    await pool.query('UPDATE payroll_components SET is_active = false WHERE id = $1', [comp.loan]);
    await fringe('3801', 'deduction');
    expect((await setUp()).body.data).toMatchObject({ created: ['LOAN', '3801'], existing: [] });
    expect((await setUp()).body.data).toMatchObject({ created: [], existing: ['LOAN', '3801'] });
    expect((await loanComponents()).filter((c) => c.active && c.code.trim() === 'LOAN' && c.type === 'deduction')).toHaveLength(1);
  });
});

describe('a LOAN component is never taxable', () => {
  it.each([['LOAN', true], [' LOAN ', true]])('POST %j with isTaxable true is refused', async (code, isTaxable) => {
    const res = await create({ name: 'Loan', sarsSourceCode: code, componentType: 'deduction', isTaxable });
    expect(res.statusCode).toBe(400);
    expect(res.body.error?.message).toContain('LOAN');
  });

  it('a LOAN-coded EARNING is not the loan deduction: it may be taxable, and is so by default', async () => {
    for (const [name, body] of [['Loan earning A', { isTaxable: true }], ['Loan earning B', {}]] as const) {
      const res = await create({ name, sarsSourceCode: 'LOAN', componentType: 'earning', ...body });
      expect(res.statusCode, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data).toMatchObject({ isTaxable: true });
    }
  });

  it('with isTaxable false, or left out, it is created non-taxable', async () => {
    for (const [name, body] of [['Loan A', { isTaxable: false }], ['Loan B', {}]] as const) {
      const res = await create({ name, sarsSourceCode: 'LOAN', componentType: 'deduction', ...body });
      expect(res.statusCode, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data).toMatchObject({ isTaxable: false });
    }
  });

  it('a LOAN deduction flagged taxable in the catalogue does not lower PAYE', async () => {
    const plain = await line(state.nov);
    await pool.query('UPDATE payroll_components SET is_taxable = true WHERE id = $1', [comp.loan]);
    await addLoan(1000);
    await recalculate(state.nov);
    const l = await line(state.nov);
    expect(l.paye).toBe(plain.paye);
    expect(l.net).toBeCloseTo(plain.net - 1000, 2);
    expect(await blocker()).toBeNull(); // the line took it as non-taxable, and says so in its breakdown
  });
});

describe('a low-interest loan with no 3801 earning (Hein: collected, and blocks until the 3801 earning exists)', () => {
  it.each([['none', null], ['a 3801 deduction', 'deduction']])('%s: the loan is collected as before; the line names the loan and the benefit; approval is blocked', async (_what, type) => {
    if (type) await fringe('3801', type);
    const plain = await line(state.nov);
    const loan = await lowInterest();
    await recalculate(state.nov);
    expect(await loanState(loan)).toEqual({ balance: 0, paidFlags: [true], payments: 1 });
    const l = await line(state.nov);
    expect({ gross: l.gross, paye: l.paye }).toEqual({ gross: plain.gross, paye: plain.paye });
    expect(l.net).toBeCloseTo(plain.net - 1000, 2);
    const warning = (await results()).find((r) => r.code === 'LOAN_FRINGE_NOT_RECORDED')!;
    expect(warning).toMatchObject({ severity: 'error' });
    expect(warning.message).toContain('R-LOAN');
    expect(warning.message.replace(/\s/g, ' ')).toContain('R 7.08');
    const b = await blocker();
    expect(b).toMatchObject({ code: 'loan_fringe_not_recorded' });
    expect(b.detail).toContain('R-LOAN');
    expect(b.detail).toContain('Setup → Pay Components');
  });

  it('a 3801 earning coded with spaces is the 3801, and the loan is taken with its benefit', async () => {
    const benefit = await fringe(' 3801 ');
    const loan = await lowInterest();
    await recalculate(state.nov);
    expect(await loanState(loan)).toMatchObject({ balance: 0, payments: 1 });
    const breakdown = (await pool.query('SELECT component_breakdown FROM payroll_run_lines WHERE run_id = $1', [state.nov])).rows[0]!.component_breakdown;
    expect(breakdown).toContainEqual(expect.objectContaining({ componentId: benefit, amount: 7.08 }));
    expect((await results()).map((r) => r.code)).toEqual([]);
    expect(await blocker()).toBeNull();
  });

  it('with neither component the loan is withheld, and the line names both, each at its own amount', async () => {
    await pool.query('UPDATE payroll_components SET is_active = false WHERE id = $1', [comp.loan]);
    const loan = await lowInterest();
    await recalculate(state.nov);
    expect(await loanState(loan)).toEqual({ balance: 1000, paidFlags: [false], payments: 0 });
    const message = (await results()).find((r) => r.code === 'LOAN_DEDUCTION_MISSING')!.message.replace(/\s/g, ' ');
    expect(message).toContain('R 1 000.00');
    expect(message).toContain('deduction coded LOAN');
    expect(message).toContain('earning coded 3801');
    expect(message).toContain('R 7.08');
    expect(message).toContain('the instalment was not taken');
    expect(await blocker()).toMatchObject({ code: 'loan_deduction_missing' });
    expect((await blocker()).detail).toContain('3801');
  });

  it('two loans withheld: one sentence, in the plural', async () => {
    await pool.query('UPDATE payroll_components SET is_active = false WHERE id = $1', [comp.loan]);
    await addLoan(1000, 'R-LOAN');
    await addLoan(500, 'R-LOAN2');
    await recalculate(state.nov);
    const message = (await results()).find((r) => r.code === 'LOAN_DEDUCTION_MISSING')!.message;
    expect(message).toMatch(/^Loans R-LOAN \(.*\) and R-LOAN2 \(.*\): no active deduction coded LOAN, so the instalments were not taken and the loans are unchanged/);
    expect((await blocker()).detail).not.toContain('3801');
  });
});

describe('a withheld instalment is named at what the loan service would take', () => {
  it('two rows due in one month: the message shows the first, as applyLoanToRun takes one', async () => {
    await pool.query('UPDATE payroll_components SET is_active = false WHERE id = $1', [comp.loan]);
    const loan = await addLoan(1000);
    await pool.query(`INSERT INTO payroll_loan_schedule (loan_id, sequence, due_period_year, due_period_month, opening_balance, interest, principal, installment, closing_balance)
      VALUES ($1, 2, 2026, 11, 0, 0, 500, 500, 0)`, [loan]);
    await recalculate(state.nov);
    const message = (await results()).find((r) => r.code === 'LOAN_DEDUCTION_MISSING')!.message;
    expect(message.replace(/\s/g, ' ')).toContain('R 1 000.00');
    expect(message.replace(/\s/g, ' ')).not.toContain('R 1 500.00');
  });

  it('an instalment taken before and withheld now is logged with why it was not taken again', async () => {
    const loan = await addLoan(1000);
    await recalculate(state.nov);
    await pool.query('UPDATE payroll_components SET is_active = false WHERE id = $1', [comp.loan]);
    const warn = vi.spyOn(log, 'warn');
    await recalculate(state.nov);
    expect(await loanState(loan)).toEqual({ balance: 1000, paidFlags: [false], payments: 0 });
    const call = warn.mock.calls.find(([message]) => String(message).includes('without re-application'));
    expect(call?.[1]).toMatchObject({ reasons: [{ loanId: loan, reason: 'no LOAN deduction' }] });
  });
});
