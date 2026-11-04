/**
 * History for the non-cash 3801 benefit suites: an employee on R41 000 cash with an interest-free
 * loan whose schedule holds the opening balance at R141 176.47, so 8.5% (the run's default official
 * rate) x 141 176.47 / 12 = R1 000.00 of benefit and a R100 instalment in every month of 2026, each
 * month calculated and APPROVED through the real routes.
 */
import { expect } from 'vitest';
import type { Pool } from 'pg';
import setupComponents from '../../pages/api/payroll/loans/setup-components';
import type { inputsFixture } from './payrun-period-inputs.helpers';
import { calculatedRun, type Route } from './w3-01-payroll.helpers';

type Fixture = ReturnType<typeof inputsFixture>;
const OPENING = 141_176.47;

export const breakdownOf = async (pool: Pool, run: string) => (await pool.query(
  'SELECT component_breakdown FROM payroll_run_lines WHERE run_id = $1', [run])).rows[0]!.component_breakdown as Array<Record<string, unknown>>;

/** The salary, the 3801 earning (as setup-components creates it) and the loan, due January to November 2026. */
export async function benefitFromJanuary(pool: Pool, fx: Fixture): Promise<void> {
  const { state, call } = fx;
  await pool.query('UPDATE payroll_employee_components SET amount = 41000 WHERE employee_id = $1', [state.employee]);
  const setup = await call(setupComponents as Route, 'POST', '/api/payroll/loans/setup-components', undefined);
  expect(setup.body.data).toMatchObject({ created: ['3801'] });
  const loan = crypto.randomUUID();
  await pool.query(
    `INSERT INTO payroll_loans (id, company_id, employee_id, loan_number, description, principal, annual_interest_rate, term_months,
       method, start_date, first_deduction_period_year, first_deduction_period_month, status, outstanding_balance)
     VALUES ($1, $2, $3, 'NC-LOAN', 'Staff loan', $4, 0, 11, 'straight_line', '2025-12-01', 2026, 1, 'active', $4)`,
    [loan, state.coA, state.employee, OPENING]);
  for (let month = 1; month <= 11; month += 1) {
    await pool.query(
      `INSERT INTO payroll_loan_schedule (loan_id, sequence, due_period_year, due_period_month, opening_balance, interest, principal, installment, closing_balance, paid_flag)
       VALUES ($1, $2, 2026, $2, $3::numeric, 0, 100, 100, $3::numeric - 100, false)`, [loan, month, OPENING]);
  }
}

/** Approve a calculated run through the preview's plan hash; refuses a blocker. */
export async function approve(fx: Fixture, run: string, what: string): Promise<void> {
  const { blocker, planHash } = (await fx.preview(run)).body.data!;
  expect(blocker, what).toBeNull();
  expect((await fx.doApprove(run, planHash)).statusCode, what).toBe(200);
}

/** Months 1..last of 2026, each calculated and approved; each carries the R1 000 benefit as non-cash. */
export async function approvedMonths(pool: Pool, fx: Fixture, last: number): Promise<void> {
  for (let month = 1; month <= last; month += 1) {
    const run = await calculatedRun(fx.call, month);
    await approve(fx, run, `month ${month}`);
    expect(await fx.header(run)).toMatchObject({ status: 'approved', gross: 41_000 });
    expect(await breakdownOf(pool, run)).toContainEqual(expect.objectContaining({ sarsSourceCode: '3801', amount: 1000, isNonCash: true }));
  }
}
