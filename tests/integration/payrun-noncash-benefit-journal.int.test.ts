/**
 * The payroll journal's labour debit per cost centre when one employee has a non-cash 3801 benefit.
 * SDL is levied on remuneration (cash + benefit), so the employee with the benefit carries more of
 * the run's SDL than their cash share says. Labour = cash gross + employer UIF + SDL − ETI, split
 * by employee: the SDL part by remuneration share, the rest by gross share as before. A run with no
 * non-cash benefit splits exactly as it did. The journal still balances and posts.
 *
 * Two employees on R41 000 cash, A with a R1 000 benefit, each in their own CC1:
 * A = 41 000 + 177.12 + 420 = R41 597.12, B = 41 000 + 177.12 + 410 = R41 587.12 (a split by cash
 * share alone gave each R41 592.12). Disposable fixture DB only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { inputsFixture } from './payrun-period-inputs.helpers';
import { approve, benefitFromJanuary } from './payrun-noncash-benefit.helpers';
import setupComponents from '../../pages/api/payroll/loans/setup-components';
import type { Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const fx = inputsFixture(pool);
const { state, line, preview, recalculate } = fx;

beforeAll(fx.setUp);
beforeEach(fx.freshCompany);
afterEach(async () => {
  vi.restoreAllMocks();
  await pool.query('UPDATE payroll_employees SET cost_centre_id = NULL WHERE company_id = $1', [state.coA]);
  // The posted labour lines carry the centres (cc1_id): gone first, as cleanPayrollCompanies would.
  await pool.query('DELETE FROM gl_journal_lines WHERE journal_entry_id IN (SELECT id FROM gl_journal_entries WHERE company_id = $1)', [state.coA]);
  await pool.query('DELETE FROM cost_centres WHERE company_id = $1', [state.coA]);
  await fx.dropCompany();
});
afterAll(fx.tearDown);

async function centre(code: string, employeeId: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query(`INSERT INTO cost_centres (id, company_id, code, name, cc_type, is_active) VALUES ($1, $2, $3, $3, 'cc1', true)`, [id, state.coA, code]);
  await pool.query('UPDATE payroll_employees SET cost_centre_id = $1 WHERE id = $2', [id, employeeId]);
  return id;
}

type PlanLine = { accountCode: string; cc1Id: string | null; debit: number; credit: number };

/** Employee A (the benefit) and a second employee B on R41 000 from `salaryComponent`, each in their own CC1. */
async function twoCentres(salaryComponent: string) {
  await benefitFromJanuary(pool, fx); // employee A: R41 000 + the R1 000 benefit in November
  const b = await fx.addEmployee('NC-B');
  await pool.query(`INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from) VALUES ($1, $2, 41000, '2020-01-01')`, [b, salaryComponent]);
  return { b, ccA: await centre('CC-A', state.employee), ccB: await centre('CC-B', b) };
}

/** The plan's labour (5200) per CC1; and that the plan balances. */
async function planLabour(): Promise<(cc: string) => number> {
  const { plan, blocker } = (await preview(state.nov)).body.data!;
  expect(blocker).toBeNull();
  const lines = plan.lines as PlanLine[];
  const debits = lines.reduce((s, l) => s + l.debit, 0);
  const credits = lines.reduce((s, l) => s + l.credit, 0);
  expect(Math.round(debits * 100)).toBe(Math.round(credits * 100));
  return (cc: string) => lines.filter((l) => l.accountCode === '5200' && l.cc1Id === cc).reduce((s, l) => s + l.debit, 0);
}

describe('labour by cost centre with a non-cash benefit', () => {
  it('puts the SDL on the benefit on the employee who has it, and the journal balances and posts', async () => {
    const salary = (await pool.query(
      `SELECT id FROM payroll_components WHERE company_id = $1 AND BTRIM(sars_source_code) = '3601' AND name = 'Basic Salary'`, [state.coA])).rows[0]!.id;
    const { b, ccA, ccB } = await twoCentres(salary);

    await recalculate(state.nov);
    expect(await line(state.nov)).toMatchObject({ gross: 41_000, taxable: 42_000, sdl: 420 });
    expect(await line(state.nov, b)).toMatchObject({ gross: 41_000, sdl: 410 });

    const labour = await planLabour();
    expect(labour(ccA)).toBeCloseTo(41_597.12, 2);
    expect(labour(ccB)).toBeCloseTo(41_587.12, 2);
    await approve(fx, state.nov, 'November');
  });

  it('gives each line its own SDL: a line with none (pay not SDL-applicable, or severance alone) carries none', async () => {
    // B's pay carries no SDL (is_sdl_applicable off): B's line levies R0, A's R420. Split by share
    // of remuneration, B would have carried R207.47 of A's levy.
    const exempt = (await pool.query(
      `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable, is_sdl_applicable)
       VALUES ($1, 'Salary (no SDL)', '3601', 'earning', true, false) RETURNING id`, [state.coA])).rows[0]!.id;
    const { b, ccA, ccB } = await twoCentres(exempt);

    await recalculate(state.nov);
    expect(await line(state.nov)).toMatchObject({ gross: 41_000, sdl: 420 });
    expect(await line(state.nov, b)).toMatchObject({ gross: 41_000, sdl: 0 });

    const labour = await planLabour();
    expect(labour(ccA)).toBeCloseTo(41_000 + 177.12 + 420, 2);
    expect(labour(ccB)).toBeCloseTo(41_000 + 177.12, 2);
    await approve(fx, state.nov, 'November');
  });

  it('a run of benefits alone (no cash gross, SDL due): each centre carries its own SDL, not one untagged line', async () => {
    // Eleven earlier months of R100 000 make the employer SDL-liable. November pays no cash: A has
    // a R5 000 benefit, B a R3 000 one, both interest-free loans with nothing due (no instalment),
    // under the tax threshold so no PAYE. Labour is the SDL alone: A R50, B R30.
    for (let back = 1; back <= 11; back += 1) {
      const index = 2026 * 12 + 11 - back;
      await pool.query(
        `INSERT INTO payroll_run_headers (company_id, period_month, period_year, status, total_gross) VALUES ($1, $2, $3, 'approved', 100000)`,
        [state.coA, ((index - 1) % 12) + 1, Math.floor((index - 1) / 12)]);
    }
    await pool.query('DELETE FROM payroll_employee_components WHERE employee_id = $1', [state.employee]);
    const setup = await fx.call(setupComponents as Route, 'POST', '/api/payroll/loans/setup-components', undefined);
    expect(setup.body.data).toMatchObject({ created: ['3801'] });
    const b = await fx.addEmployee('NC-B');
    // 8.5% x opening / 12 = the benefit; the schedule's opening balance decides it.
    for (const [employeeId, opening] of [[state.employee, 705_882.35], [b, 423_529.41]] as const) {
      const loan = crypto.randomUUID();
      await pool.query(
        `INSERT INTO payroll_loans (id, company_id, employee_id, loan_number, description, principal, annual_interest_rate, term_months,
           method, start_date, first_deduction_period_year, first_deduction_period_month, status, outstanding_balance)
         VALUES ($1, $2, $3, $4, 'Staff loan', $5, 0, 12, 'straight_line', '2026-10-01', 2026, 11, 'active', $5)`,
        [loan, state.coA, employeeId, `NC-${employeeId.slice(0, 4)}`, opening]);
      await pool.query(
        `INSERT INTO payroll_loan_schedule (loan_id, sequence, due_period_year, due_period_month, opening_balance, interest, principal, installment, closing_balance, paid_flag)
         VALUES ($1, 1, 2026, 11, $2::numeric, 0, 0, 0, $2::numeric, false)`, [loan, opening]);
    }
    const ccA = await centre('CC-A', state.employee);
    const ccB = await centre('CC-B', b);

    await recalculate(state.nov);
    expect(await line(state.nov)).toMatchObject({ gross: 0, taxable: 5_000, paye: 0, sdl: 50 });
    expect(await line(state.nov, b)).toMatchObject({ gross: 0, taxable: 3_000, paye: 0, sdl: 30 });

    const labour = await planLabour();
    expect(labour(ccA)).toBeCloseTo(50, 2);
    expect(labour(ccB)).toBeCloseTo(30, 2);
    await approve(fx, state.nov, 'November');
  });
});
