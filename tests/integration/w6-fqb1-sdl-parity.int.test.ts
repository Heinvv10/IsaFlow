/**
 * Wave 6 FQb1, review #1507 round 4: the SDL month gate re-judges a run on its STORED remuneration
 * (estimateAnnualRemuneration 'stored': total_gross - contractor gross + the flagged non-cash items), while the
 * calculation judged it on the figure it costed (the non-contractor lines' remuneration, payrollCalculator allEarnings).
 * If those differed, a refusal could never be cleared by recalculating. Proved here on a real calculation through the
 * routes, with a cash salary, a non-cash 3810 benefit and an independent contractor's fee: the stored figure is the
 * costed one, the gate passes the run it just costed, and a single-run month whose own decision is stale is cleared by
 * recalculating it. Disposable fixture DB only; the run is committed (the routes run their own transactions).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import { als } from '@/lib/als';
import calculate from '../../pages/api/payroll/runs/[id]/calculate';
import { estimateAnnualRemuneration } from '@/modules/accounting/services/payroll/sdlLeviabilityService';
import { sdlMonthSplitRefusal } from '@/modules/accounting/services/payroll/payrollSdlMonthGate';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatedRun, cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const A = crypto.randomUUID();
const admin = crypto.randomUUID();
const tokens: Record<string, string> = {};
const call = routeCaller(tokens, { user: admin, company: A });
let runId = '';

const one = async (text: string, params: unknown[] = []) => (await pool.query(text, params)).rows[0] as Record<string, unknown>;
/** Service calls as the company (the services read through als, as a request does). */
const asA = <T>(fn: () => Promise<T>): Promise<T> => als.run({ userId: admin, companyId: A, claims: { sub: admin } } as never, fn);
const MAY = { year: 2026, month: 5 };

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id, name) VALUES ($1, $2)', [A, 'W6 FQb1 SDL parity']);
  const salary = await seedPayrollCompany(pool, A, 20000);
  const employee = String((await one('SELECT employee_id FROM payroll_employee_components WHERE id = $1', [salary])).employee_id);
  // The employer's medical contribution: a 3810 earning, never cash (employerContributions.markNonCashEmployerBenefits).
  const medical = String((await one(
    "INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable) VALUES ($1, 'Medical aid (employer)', '3810', 'earning', true) RETURNING id",
    [A])).id);
  await pool.query("INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from) VALUES ($1, $2, 1500, '2020-01-01')", [employee, medical]);
  // An independent contractor's fee: not remuneration for the s4(b) threshold on either side.
  const contractor = String((await one(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, tax_number, tax_status)
     VALUES ($1, 'FQB1-C', 'Conn', 'Tractor', '2020-01-01', '1980-01-01', '0123456780', 'independent_contractor') RETURNING id`, [A])).id);
  await pool.query(
    "INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from) SELECT $1, component_id, 9000, '2020-01-01' FROM payroll_employee_components WHERE id = $2",
    [contractor, salary]);
  await pool.query("INSERT INTO users(id, email, role, is_active) VALUES ($1, $2, 'admin', true)", [admin, `${admin}@example.invalid`]);
  tokens[admin] = await new SignJWT({ sub: admin, aal: 'aal2', session_id: crypto.randomUUID() }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  await pool.query("INSERT INTO company_users(company_id, user_id, role) VALUES ($1, $2, 'admin')", [A, admin]);
  runId = await calculatedRun(call, 5);
});

afterAll(async () => {
  try {
    await cleanPayrollCompanies(pool, [A]);
    await pool.query('DELETE FROM users WHERE id = $1', [admin]);
  } finally { await pool.end(); }
});

describe('the SDL month gate reads the run as the calculation costed it', () => {
  it('the calculation costed the contractor and the 3810 as expected', async () => {
    const lines = (await pool.query(
      `SELECT e.tax_status, l.gross_pay::float8 AS gross, l.sdl_exempt,
              (SELECT COALESCE(SUM((i->>'amount')::numeric), 0) FROM jsonb_array_elements(l.component_breakdown) i WHERE i->>'isNonCash' = 'true')::float8 AS non_cash
         FROM payroll_run_lines l JOIN payroll_employees e ON e.id = l.employee_id WHERE l.run_id = $1 ORDER BY e.tax_status`, [runId])).rows;
    expect(lines).toEqual([
      { tax_status: 'employee', gross: 20000, sdl_exempt: true, non_cash: 1500 },
      { tax_status: 'independent_contractor', gross: 9000, sdl_exempt: true, non_cash: 0 },
    ]);
  });

  it("the stored figure is the costed one (salary + non-cash 3810, contractor's fee out) and the gate passes the run", async () => {
    // 258 000 is hand-computed: (20 000 salary + 1 500 non-cash 3810) x 12, the contractor's 9 000 left out. That is
    // the figure the calculation costs (the non-contractor lines' allEarnings); its own stored decision is checked above.
    const got = await asA(async () => ({
      stored: await estimateAnnualRemuneration(A, MAY, 'stored', runId),
      refusal: await sdlMonthSplitRefusal(A, runId),
    }));
    expect(got).toEqual({ stored: 258000, refusal: null });
  });

  it('a single-run month whose own stored decision is stale is refused, and recalculating the run clears it', async () => {
    await pool.query('UPDATE payroll_run_lines SET sdl_exempt = false WHERE run_id = $1', [runId]); // costed on a stale month
    const before = await asA(() => sdlMonthSplitRefusal(A, runId));
    expect(before?.detail).toMatch(/To approve: recalculate this run\.$/);
    const recalc = await call(calculate as Route, 'POST', `/api/payroll/runs/${runId}/calculate`, runId);
    expect(recalc.statusCode).toBe(200);
    expect(await asA(() => sdlMonthSplitRefusal(A, runId))).toBeNull();
  });
});
