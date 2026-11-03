/**
 * The low-interest loan benefit (SARS 3801, non-cash) end to end through the real routes: ten
 * months calculated and APPROVED with the benefit, then the eleventh. Each month's line is taxed on
 * the benefit and SDL-levied on it but does not pay it in cash; gross_pay / total_gross stay cash
 * only, the benefit is the breakdown's `isNonCash` item, and the SDL threshold (s4(b), R500 000 a
 * year) reads those items back from the approved months.
 *
 * R41 000 cash + R1 000 benefit a month from January: (10 x R42 000 + R42 000) / 11 elapsed months
 * x 12 = R504 000, levied. Cash gross alone read (10 x R41 000 + R42 000) / 11 x 12 = R493 090.91,
 * and the employer came out exempt. Disposable fixture DB only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import setupComponents from '../../pages/api/payroll/loans/setup-components';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { inputsFixture } from './payrun-period-inputs.helpers';
import { calculatedRun, type Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = inputsFixture(pool);
const { state, line, header, preview, doApprove, recalculate, call } = fx;

beforeAll(fx.setUp);
beforeEach(fx.freshCompany);
afterEach(async () => { vi.restoreAllMocks(); await fx.dropCompany(); });
afterAll(fx.tearDown);

// Interest-free, with the schedule's opening balance held at R141 176.47: 8.5% (the run's default
// official rate) x 141 176.47 / 12 = R1 000.00 of benefit in every month, R100 instalment.
const OPENING = 141_176.47;
async function loanFromJanuary(): Promise<string> {
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
  return loan;
}

const breakdownOf = async (run: string) => (await pool.query(
  'SELECT component_breakdown FROM payroll_run_lines WHERE run_id = $1', [run])).rows[0]!.component_breakdown as Array<Record<string, unknown>>;

describe('a non-cash 3801 benefit through approved pay runs', () => {
  it('is taxed and levied each month, never paid in cash, and counts toward the SDL threshold from the approved months', async () => {
    await pool.query('UPDATE payroll_employee_components SET amount = 41000 WHERE employee_id = $1', [state.employee]);
    const setup = await call(setupComponents as Route, 'POST', '/api/payroll/loans/setup-components', undefined);
    expect(setup.body.data).toMatchObject({ created: ['3801'] });
    await loanFromJanuary();

    for (let month = 1; month <= 10; month += 1) {
      const run = await calculatedRun(call, month);
      const { blocker, planHash } = (await preview(run)).body.data!;
      expect(blocker, `month ${month}`).toBeNull();
      expect((await doApprove(run, planHash)).statusCode, `approve month ${month}`).toBe(200);
      expect(await header(run)).toMatchObject({ status: 'approved', gross: 41_000 });
      expect(await breakdownOf(run)).toContainEqual(expect.objectContaining({ sarsSourceCode: '3801', amount: 1000, isNonCash: true }));
    }

    await recalculate(state.nov);
    const nov = await line(state.nov);
    expect(nov.gross).toBe(41_000);
    expect(nov.taxable).toBe(42_000);
    // Paid in cash: the salary less the R100 instalment, PAYE and UIF. Not the R1 000 benefit.
    expect(nov.net).toBeCloseTo(41_000 - 100 - nov.paye - nov.uif, 2);
    // UIF on the salary only (above the R17 712 ceiling either way): 1% of the ceiling.
    expect(nov.uif).toBe(177.12);
    // 1% of R42 000: levied, since R504 000 > R500 000. On cash gross history it was nil.
    expect(nov.sdl).toBe(420);
    expect(await header(state.nov)).toMatchObject({ gross: 41_000 });
  });
});
