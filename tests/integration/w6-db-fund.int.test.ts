/**
 * Wave 6 DBF through the real routes and real Postgres (disposable fixture only), two tenants: an employer's defined-benefit
 * pension contribution valued per the Seventh Schedule para 12D(3), X = A x B - C (Sage Payroll Tax Pocket Guide 2025-2026
 * s7.12.2; the Act not fetched, UNVERIFIED), non-cash and deemed paid by the employee into s11F (PAYE-GEN-01-G21 (2027)
 * Rev 1 p. 10), where the cap binds. Refused assignments write nothing; migration 999s's CHECK refuses a factor beside a
 * percent_of_rfi; FQa's guard no longer refuses the run; the approval gate and the run grid treat the row as RF's percent rows.
 * Company B is costed at 10x the pay in a later month, so neither the figures nor the rows can leak between tenants.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import components from '../../pages/api/payroll/components/index';
import component from '../../pages/api/payroll/components/[id]';
import assignments from '../../pages/api/payroll/employees/[id]/components';
import approve from '../../pages/api/payroll/runs/[id]/approve';
import journalPlan from '../../pages/api/payroll/runs/[id]/journal-plan';
import { getIrp5EmployeeTotals } from '../../src/modules/accounting/services/payroll/irp5DataService';
import { runLinesRefusal } from '../../src/modules/accounting/services/payroll/payrollRunRecalcGate';
import { writeRunRow } from '../../src/modules/accounting/services/payroll/payrollRunRowWrite';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { authorisePayRun, calculatedRun, cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const A = crypto.randomUUID();
const B = crypto.randomUUID();
const owner = crypto.randomUUID();
const approver = crypto.randomUUID();
const tokens: Record<string, string> = {};
const call = routeCaller(tokens, { user: owner, company: A });
const sign = (sub: string) => new SignJWT({ sub, aal: 'aal2', session_id: crypto.randomUUID() }).setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
const emp: Record<string, string> = {};
const dbComp: Record<string, string> = {};
const pensionComp: Record<string, string> = {};

const count = async (text: string, values: unknown[]) => Number((await pool.query<{ n: string }>(text, values)).rows[0]!.n);
const assignmentRows = (co: string) => count(
  'SELECT count(*) AS n FROM payroll_employee_components WHERE employee_id IN (SELECT id FROM payroll_employees WHERE company_id = $1)', [co]);
const create = (co: string, body: Record<string, unknown>) => call(components as Route, 'POST', '/api/payroll/components', undefined, { company: co, body });
const assign = (co: string, body: Record<string, unknown>) => call(assignments as Route, 'POST', `/api/payroll/employees/${emp[co]}/components`, emp[co],
  { company: co, body: { effectiveFrom: '2026-03-01', ...body } });
type Line = { gross_pay: string; paye: string; net_pay: string; retirement_contributions: string; retirement_deduction: string;
  component_breakdown: Array<Record<string, unknown>>; validation_results: Array<{ code: string }>; explanation: { paye: { caution?: string } } };
const lineOf = async (runId: string) => (await pool.query<Line>(
  `SELECT gross_pay, paye, net_pay, retirement_contributions, retirement_deduction, component_breakdown, validation_results, explanation
     FROM payroll_run_lines WHERE run_id = $1`, [runId])).rows[0]!;

beforeAll(async () => {
  for (const [co, name, salary] of [[A, 'DBF A', 20_000], [B, 'DBF B', 200_000]] as const) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [co, name]);
    await seedPayrollCompany(pool, co, salary);
    // The fund's RFI is the basic salary (migration 975's rule for a 3601; the seed writes the component after 975 ran).
    await pool.query("UPDATE payroll_components SET counts_as_rfi = true WHERE company_id = $1 AND sars_source_code = '3601'", [co]);
    emp[co] = (await pool.query<{ id: string }>('SELECT id FROM payroll_employees WHERE company_id = $1', [co])).rows[0]!.id;
  }
  await pool.query(`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level)
    VALUES ($1, '2175', 'Other Employee Deductions Payable', 'liability', 'credit', 1)`, [A]);
  for (const u of [owner, approver]) {
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [u, `${u}@example.invalid`]);
    tokens[u] = await sign(u);
    for (const co of [A, B]) await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner')", [co, u]);
  }
});

afterAll(async () => {
  try {
    await pool.query("DELETE FROM audit_log WHERE company_id = ANY($1) AND entity_type IN ('payroll_component', 'payroll_employee_component')", [[A, B]]);
    await cleanPayrollCompanies(pool, [A, B]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[owner, approver]]);
  } finally { await pool.end(); }
});

describe('the components: a defined-benefit pension fund contribution is created; an RA as defined-benefit is not', () => {
  it('creates a 3817 defined-benefit earning and a 4001 deduction in each company', async () => {
    for (const co of [A, B]) {
      const made = await create(co, { name: 'Employer DB pension', sarsSourceCode: '3817', componentType: 'earning', fundType: 'defined_benefit' });
      expect(made.statusCode).toBe(201);
      dbComp[co] = String(made.body.data!.id);
      pensionComp[co] = String((await create(co, { name: 'Pension', sarsSourceCode: '4001', componentType: 'deduction' })).body.data!.id);
    }
    expect((await create(A, { name: 'RA', sarsSourceCode: '3828', componentType: 'earning', fundType: 'defined_benefit' })).statusCode).toBe(400);
  });
});

describe('assigning a factor: every refusal writes nothing', () => {
  it('refuses a factor beside a percent_of_rfi, on a 4001, with an amount, once-off, out of range, or on another company\'s component', async () => {
    const before = await assignmentRows(A);
    const refused = [
      { componentId: dbComp[A], amount: 0, dbMemberCategoryFactor: 0.4, percentOfRfi: 0.15 },
      { componentId: pensionComp[A], amount: 0, dbMemberCategoryFactor: 0.4 },
      { componentId: dbComp[A], amount: 500, dbMemberCategoryFactor: 0.4 },
      { componentId: dbComp[A], amount: 0, dbMemberCategoryFactor: 0.4, isRecurring: false },
      { componentId: dbComp[A], amount: 0, dbMemberCategoryFactor: 1.5 },
      { componentId: dbComp[A], amount: 0, dbMemberCategoryFactor: '0.4' },
      { componentId: dbComp[B], amount: 0, dbMemberCategoryFactor: 0.4 },
    ];
    for (const body of refused) expect((await assign(A, body)).statusCode, JSON.stringify(body)).toBe(400);
    const pair = await assign(A, refused[0]!);
    expect(String(pair.body.error?.message)).toMatch(/cannot be on the same assignment/);
    expect(await assignmentRows(A)).toBe(before);
  });

  it('migration 999s refuses the pair, an amount and a factor over 1 in the table itself', async () => {
    for (const [amount, factor, pct] of [[0, 0.4, 0.15], [500, 0.4, null], [0, 1.5, null]] as const) {
      await expect(pool.query(`INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, db_member_category_factor, percent_of_rfi)
        VALUES ($1, $2, $3, '2026-03-01', $4, $5)`, [emp[A], dbComp[A], amount, factor, pct])).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('stores A\'s 0.40 factor with the R1 500 pension, and B\'s 0.20 with R10 000', async () => {
    const made = await assign(A, { componentId: dbComp[A], amount: 0, dbMemberCategoryFactor: 0.4 });
    expect(made.statusCode).toBe(201);
    expect(made.body.data).toMatchObject({ amount: 0, dbMemberCategoryFactor: 0.4, percentOfRfi: null });
    expect((await assign(A, { componentId: pensionComp[A], amount: 1500 })).statusCode).toBe(201);
    expect((await assign(B, { componentId: dbComp[B], amount: 0, dbMemberCategoryFactor: 0.2 })).statusCode).toBe(201);
    expect((await assign(B, { componentId: pensionComp[B], amount: 10_000 })).statusCode).toBe(201);
  });
});

describe('a run values it, the s11F cap binds, and the run is approved', () => {
  let runA = '';
  it('A, March: X = 0.40 x 20 000 - 1 500 = 6 500, non-cash; 8 000 contributed, 27.5% x 26 500 = 7 287.50 allowed', async () => {
    runA = await calculatedRun(call, 3, { company: A });
    const line = await lineOf(runA);
    expect(line.component_breakdown.find((b) => b.sarsSourceCode === '3817')).toMatchObject({
      amount: 6500, isNonCash: true, dbMemberCategoryFactor: 0.4, rfiBase: 20000, dbEmployeeContribution: 1500,
    });
    // PAYE as oracle case db-fund-12d-s11f-cap-binds (1 973.25) less the seed's main-member medical credit (R376 for 2027):
    // 1 597.25; net 20 000 - 1 500 - 1 597.25 - UIF 177.12.
    expect([line.gross_pay, line.retirement_contributions, line.retirement_deduction, line.paye, line.net_pay].map(Number))
      .toEqual([20000, 8000, 7287.5, 1597.25, 16725.63]);
    expect(line.validation_results.map((v) => v.code)).toContain('DB_FUND_FACTOR_UNVERIFIED');
    expect(line.explanation.paye.caution).toContain('para 12D(3)');
  });

  it('B, September at 10x: X = 0.20 x 200 000 - 10 000 = 30 000; the R430 000 cap binds (R35 833.33 a month); A is untouched', async () => {
    const runB = await calculatedRun(call, 9, { company: B });
    const line = await lineOf(runB);
    expect(line.component_breakdown.find((b) => b.sarsSourceCode === '3817')).toMatchObject({ amount: 30000, rfiBase: 200000, dbEmployeeContribution: 10000 });
    expect([line.retirement_contributions, line.retirement_deduction].map(Number)).toEqual([40000, 35833.33]);
    expect(Number((await lineOf(runA)).retirement_deduction)).toBe(7287.5);
    expect(await count('SELECT count(*) AS n FROM payroll_run_headers WHERE company_id = $1', [A])).toBe(1);
  });

  it('A is approved (FQa\'s factor clause is lifted) and the certificate data carries 6 500 under 3817', async () => {
    await authorisePayRun(call, runA, approver);
    const plan = await call(journalPlan as Route, 'GET', `/api/payroll/runs/${runA}/journal-plan`, runA);
    expect((await call(approve as Route, 'POST', `/api/payroll/runs/${runA}/approve`, runA, { body: { expectedPlanHash: plan.body.data!.planHash } })).statusCode).toBe(200);
    const row = (await getIrp5EmployeeTotals(A, 2027, { employeeId: emp[A] })).rows[0]!;
    expect(row.fringeBenefits).toEqual([{ sourceCode: '3817', amount: 6500 }]);
  });
});

describe('the approval gate and the run grid treat a defined-benefit row as RF\'s percent rows', () => {
  it('A, April: switching counts_as_rfi on the line\'s salary after calculation says recalculate', async () => {
    const runId = await calculatedRun(call, 4, { company: A });
    expect(await runLinesRefusal(A, runId)).toBeNull();
    const basic = (await pool.query<{ id: string }>("SELECT id FROM payroll_components WHERE company_id = $1 AND name = 'Basic Salary'", [A])).rows[0]!.id;
    const patch = (on: boolean) => call(component as Route, 'PATCH', `/api/payroll/components/${basic}`, basic, { company: A, body: { countsAsRfi: on } });
    expect((await patch(false)).statusCode).toBe(200);
    expect((await runLinesRefusal(A, runId))?.code).toBe('components_changed_after_calculation');
    expect((await patch(true)).statusCode).toBe(200);
  });

  it('A, April: writeRunRow on the defined-benefit row is a 400, not the CHECK 500, and the row keeps amount 0', async () => {
    const runId = (await pool.query<{ id: string }>('SELECT id FROM payroll_run_headers WHERE company_id = $1 AND period_month = 4', [A])).rows[0]!.id;
    const row = (await pool.query<{ id: string }>(
      'SELECT id FROM payroll_employee_components WHERE employee_id = $1 AND db_member_category_factor IS NOT NULL', [emp[A]])).rows[0]!.id;
    await expect(writeRunRow({
      companyId: A, runId, employeeId: emp[A], componentId: dbComp[A], componentType: 'earning', period: { year: 2026, month: 4 },
      rowId: row, amount: 100, clear: false, quantity: null, actor: { userId: owner, channel: 'service' },
    })).rejects.toMatchObject({ status: 400 });
    expect(await count('SELECT count(*) AS n FROM payroll_employee_components WHERE id = $1 AND amount = 0', [row])).toBe(1);
  });
});
