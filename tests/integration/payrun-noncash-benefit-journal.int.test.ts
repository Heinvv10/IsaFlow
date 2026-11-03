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
});
