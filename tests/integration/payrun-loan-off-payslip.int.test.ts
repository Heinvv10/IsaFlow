/**
 * A run calculated before loans failed closed could record a loan payment with nothing on the
 * payslip, or show it on the wrong component: a LOAN-coded earning, a LOAN deduction taken off PAYE
 * income, a 3801 deduction. The gate refuses such a run until it is recalculated
 * (loan_payments_off_payslip). The item must be that component (by id), of that amount, of that
 * kind. A fringe benefit with no 3801 item at all is the warning case (Hein), not refused.
 * Fixtures edit a fresh line into what the old code stored. Disposable fixture DB only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { inputsFixture } from './payrun-period-inputs.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = inputsFixture(pool);
const { state, preview, recalculate, addLoan, addComponent, addRow } = fx;
const comp = state.comp;

beforeAll(fx.setUp);
beforeEach(fx.freshCompany);
afterEach(fx.dropCompany);
afterAll(fx.tearDown);

const blocker = async () => (await preview(state.nov)).body.data!.blocker;
const lowInterest = async () => {
  const loan = await addLoan(1000);
  await pool.query('UPDATE payroll_loans SET annual_interest_rate = 0 WHERE id = $1', [loan]);
  return loan;
};
/** Rewrite the items coded `code` on the run's lines. */
const rewrite = (code: string, set: string, values: unknown[] = []) => pool.query(
  `UPDATE payroll_run_lines SET component_breakdown = (
     SELECT COALESCE(jsonb_agg(CASE WHEN BTRIM(i->>'sarsSourceCode') = $2 THEN ${set} ELSE i END ORDER BY o), '[]'::jsonb)
       FROM jsonb_array_elements(component_breakdown) WITH ORDINALITY AS e(i, o))
   WHERE run_id = $1`, [state.nov, code, ...values]);
const strip = (code: string) => pool.query(
  `UPDATE payroll_run_lines SET component_breakdown = (
     SELECT COALESCE(jsonb_agg(i ORDER BY o), '[]'::jsonb) FROM jsonb_array_elements(component_breakdown) WITH ORDINALITY AS e(i, o)
      WHERE BTRIM(i->>'sarsSourceCode') <> $2)
   WHERE run_id = $1`, [state.nov, code]);
const refused = async () => {
  const b = await blocker();
  expect(b).toMatchObject({ code: 'loan_payments_off_payslip' });
  expect(b.detail).toContain('W301-1');
  expect(b.detail).toContain('R-LOAN');
  expect(b.detail).toContain('Recalculate this run');
};

describe('a LOAN payment', () => {
  it('a run as calculated now is not refused', async () => {
    await addLoan(1000);
    await recalculate(state.nov);
    expect(await blocker()).toBeNull();
  });

  it('with no LOAN item on the line', async () => {
    await addLoan(1000);
    await recalculate(state.nov);
    await strip('LOAN');
    await refused();
  });

  it('with a LOAN item of another amount', async () => {
    await addLoan(1000);
    await recalculate(state.nov);
    await rewrite('LOAN', `jsonb_set(i, '{amount}', '999')`);
    await refused();
  });

  it('with the amount on another component: an item of the same amount is not the LOAN deduction', async () => {
    await addRow(comp.union!, 1000, '2026-01-01', null, true);
    await addLoan(1000);
    await recalculate(state.nov);
    await strip('LOAN');
    await refused();
  });

  it('on a LOAN-coded earning', async () => {
    await addLoan(1000);
    await recalculate(state.nov);
    await pool.query(`UPDATE payroll_components SET component_type = 'earning' WHERE id = $1`, [comp.loan]);
    await refused();
  });

  it('on a LOAN deduction taken as taxable (the old calculator took it off PAYE income)', async () => {
    await addLoan(1000);
    await recalculate(state.nov);
    await rewrite('LOAN', `jsonb_set(i, '{isTaxable}', 'true')`);
    await refused();
  });
});

describe('a fringe benefit', () => {
  it('with no 3801 item at all: the warning case, not refused', async () => {
    await addComponent(state.coA, 'Low-interest loan benefit', '3801', 'earning', true);
    await lowInterest();
    await recalculate(state.nov);
    await strip('3801');
    expect(await blocker()).toBeNull();
  });

  it('on a 3801 deduction (the old code took any 3801): refused', async () => {
    const benefit = await addComponent(state.coA, 'Low-interest loan benefit', '3801', 'earning', true);
    await lowInterest();
    await recalculate(state.nov);
    await pool.query(`UPDATE payroll_components SET component_type = 'deduction' WHERE id = $1`, [benefit]);
    await refused();
  });

  it('on a 3801 item of another amount: refused', async () => {
    await addComponent(state.coA, 'Low-interest loan benefit', '3801', 'earning', true);
    await lowInterest();
    await recalculate(state.nov);
    await rewrite('3801', `jsonb_set(i, '{amount}', '1')`);
    await refused();
  });
});
