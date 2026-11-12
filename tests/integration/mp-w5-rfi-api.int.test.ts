/**
 * Wave 5 RF through the real routes and real Postgres (disposable fixture only): the component and assignment refusals write
 * nothing, another company's component is 404, a run costs the employer's 15% of RFI as a non-cash 3817 deemed into s11F,
 * the journal books it to 2175, the certificate data carries it, and a counts_as_rfi switch after calculation refuses approval.
 * PAYE-GEN-01-G21 (2027) Rev 1 p. 10; BRS V25.3.0 p. 55, 94, 101, 103.
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
const companyA = crypto.randomUUID();
const companyB = crypto.randomUUID();
const owner = crypto.randomUUID();
const approver = crypto.randomUUID();
const tokens: Record<string, string> = {};
const call = routeCaller(tokens, { user: owner, company: companyA });
const sign = (sub: string) => new SignJWT({ sub, aal: 'aal2', session_id: crypto.randomUUID() }).setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
let empA = '';
let salaryB = '';
let pensionComponent = '';
let erComponent = '';

const count = async (text: string, values: unknown[]) => Number((await pool.query<{ n: string }>(text, values)).rows[0]!.n);
const componentRows = () => count('SELECT count(*) AS n FROM payroll_components WHERE company_id = $1', [companyA]);
const assignmentRows = () => count('SELECT count(*) AS n FROM payroll_employee_components WHERE employee_id = $1', [empA]);
const create = (body: Record<string, unknown>) => call(components as Route, 'POST', '/api/payroll/components', undefined, { body });
const patch = (id: string, body: unknown) => call(component as Route, 'PATCH', `/api/payroll/components/${id}`, id, { body });
const assign = (body: Record<string, unknown>) => call(assignments as Route, 'POST', `/api/payroll/employees/${empA}/components`, empA,
  { body: { effectiveFrom: '2026-03-01', ...body } });
const er = (over: Record<string, unknown> = {}) => ({ name: 'Employer pension', sarsSourceCode: '3817', componentType: 'earning', ...over });

beforeAll(async () => {
  for (const [c, name] of [[companyA, 'RF api A'], [companyB, 'RF api B']] as const) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [c, name]);
    await seedPayrollCompany(pool, c);
  }
  await pool.query(`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level)
    VALUES ($1, '2175', 'Other Employee Deductions Payable', 'liability', 'credit', 1)`, [companyA]);
  for (const u of [owner, approver]) {
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [u, `${u}@test.local`]);
    tokens[u] = await sign(u);
    await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner')", [companyA, u]);
  }
  empA = (await pool.query<{ id: string }>('SELECT id FROM payroll_employees WHERE company_id = $1', [companyA])).rows[0]!.id;
  salaryB = (await pool.query<{ id: string }>("SELECT id FROM payroll_components WHERE company_id = $1 AND sars_source_code = '3601'", [companyB])).rows[0]!.id;
});

afterAll(async () => {
  try {
    await pool.query("DELETE FROM audit_log WHERE company_id = ANY($1) AND entity_type IN ('payroll_component', 'payroll_employee_component')", [[companyA, companyB]]);
    await cleanPayrollCompanies(pool, [companyA, companyB]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[owner, approver]]);
  } finally { await pool.end(); }
});

describe('creating components: every refusal writes nothing', () => {
  it('an employer fund contribution for a defined-benefit fund, with no fund type, or not taxable', async () => {
    const before = await componentRows();
    const db = await create(er({ fundType: 'defined_benefit' }));
    expect(db.statusCode).toBe(400);
    expect(String(db.body.error?.message)).toMatch(/DEFINED-BENEFIT/);
    expect((await create(er())).statusCode).toBe(400);
    expect((await create(er({ fundType: 'defined_contribution', isTaxable: false }))).statusCode).toBe(400);
    expect((await create(er({ fundType: 'defined_contribution', countsAsRfi: true }))).statusCode).toBe(400);
    // UIF and SDL are levied on it (UI Contributions Act s1; UIF-GEN-01-G01 p. 5; G21 p. 11).
    expect((await create(er({ fundType: 'defined_contribution', isUifApplicable: false }))).statusCode).toBe(400);
    expect((await create(er({ fundType: 'defined_contribution', isSdlApplicable: false }))).statusCode).toBe(400);
    expect((await create({ name: 'Union', sarsSourceCode: 'UNION', componentType: 'deduction', countsAsRfi: true })).statusCode).toBe(400);
    expect(await componentRows()).toBe(before);
  });
  it('a defined-contribution 3817 is created not counting as RFI; a new 3601 counts by default', async () => {
    const made = await create(er({ fundType: 'defined_contribution' }));
    expect(made.statusCode).toBe(201);
    erComponent = String(made.body.data!.id);
    expect(made.body.data).toMatchObject({ sarsSourceCode: '3817', isTaxable: true, countsAsRfi: false });
    const salary = await create({ name: 'Second salary', sarsSourceCode: '3601', componentType: 'earning' });
    expect(salary.body.data).toMatchObject({ countsAsRfi: true });
    const pension = await create({ name: 'Pension', sarsSourceCode: '4001', componentType: 'deduction' });
    pensionComponent = String(pension.body.data!.id);
  });
});

describe('switching counts_as_rfi', () => {
  it('another company\'s component is 404 and is not changed', async () => {
    expect((await patch(salaryB, { countsAsRfi: true })).statusCode).toBe(404);
    expect(await count('SELECT count(*) AS n FROM payroll_components WHERE id = $1 AND counts_as_rfi', [salaryB])).toBe(0);
  });
  it('a deduction or an employer contribution cannot count; an unknown field is refused; nothing changes', async () => {
    expect((await patch(pensionComponent, { countsAsRfi: true })).statusCode).toBe(400);
    expect((await patch(erComponent, { countsAsRfi: true })).statusCode).toBe(400);
    expect((await patch(erComponent, { countsAsRfi: false, isTaxable: false })).statusCode).toBe(400);
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE company_id = $1 AND entity_type = 'payroll_component'", [companyA])).toBe(0);
  });
  it('the seeded Basic Salary is switched on, audited', async () => {
    const salary = (await pool.query<{ id: string }>("SELECT id FROM payroll_components WHERE company_id = $1 AND name = 'Basic Salary'", [companyA])).rows[0]!.id;
    expect((await patch(salary, { countsAsRfi: true })).statusCode).toBe(200);
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE company_id = $1 AND entity_type = 'payroll_component' AND entity_id = $2", [companyA, salary])).toBe(1);
  });
});

describe('assigning a percentage of RFI', () => {
  it('refuses an amount beside it, a percentage over 100%, a string, and a component that is no retirement contribution; nothing is written', async () => {
    const before = await assignmentRows();
    const salary = (await pool.query<{ id: string }>("SELECT id FROM payroll_components WHERE company_id = $1 AND name = 'Basic Salary'", [companyA])).rows[0]!.id;
    expect((await assign({ componentId: erComponent, amount: 500, percentOfRfi: 0.15 })).statusCode).toBe(400);
    expect((await assign({ componentId: erComponent, amount: 0, percentOfRfi: 1.5 })).statusCode).toBe(400);
    expect((await assign({ componentId: erComponent, amount: 0, percentOfRfi: '0.15' })).statusCode).toBe(400);
    expect((await assign({ componentId: salary, amount: 0, percentOfRfi: 0.1 })).statusCode).toBe(400);
    // A percentage is recurring: a once-off one would be a one-month row the run grid then edits as an amount.
    expect((await assign({ componentId: erComponent, amount: 0, percentOfRfi: 0.15, isRecurring: false })).statusCode).toBe(400);
    // A pre-RF component that is not taxable cannot take a new (RF-treated) assignment.
    const untaxed = (await pool.query<{ id: string }>(
      "INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable) VALUES ($1, 'Old employer RA', '3828', 'earning', false) RETURNING id",
      [companyA])).rows[0]!.id;
    expect((await assign({ componentId: untaxed, amount: 500 })).statusCode).toBe(400);
    expect(await assignmentRows()).toBe(before);
  });
  it('stores the employer\'s 15% and the employee\'s R4 000 pension', async () => {
    const made = await assign({ componentId: erComponent, amount: 0, percentOfRfi: 0.15 });
    expect(made.statusCode).toBe(201);
    expect(made.body.data).toMatchObject({ amount: 0, percentOfRfi: 0.15 });
    expect((await assign({ componentId: pensionComponent, amount: 4000 })).statusCode).toBe(201);
  });
});

describe('a run costs it, the journal books it, the certificate carries it', () => {
  let runId = '';
  it('March: a non-cash 3817 of 15% x 20 000, deemed into s11F: 7 000 contributed, 6 325 allowed', async () => {
    runId = await calculatedRun(call, 3);
    const line = (await pool.query<{ gross_pay: string; retirement_contributions: string; retirement_deduction: string; component_breakdown: Array<Record<string, unknown>> }>(
      'SELECT gross_pay, retirement_contributions, retirement_deduction, component_breakdown FROM payroll_run_lines WHERE run_id = $1', [runId])).rows[0]!;
    expect(line.component_breakdown.find((b) => b.sarsSourceCode === '3817')).toMatchObject({ amount: 3000, isNonCash: true, percentOfRfi: 0.15, rfiBase: 20000 });
    expect([Number(line.gross_pay), Number(line.retirement_contributions), Number(line.retirement_deduction)]).toEqual([20000, 7000, 6325]);
  });
  it('the journal plan credits 3 000 to 2175 payable to the fund, and balances', async () => {
    const plan = await call(journalPlan as Route, 'GET', `/api/payroll/runs/${runId}/journal-plan`, runId);
    const built = plan.body.data!.plan as { lines: Array<{ accountCode: string; credit: number; description: string }>; totalDebit: number; totalCredit: number };
    expect(built.lines.filter((l) => l.accountCode === '2175' && /retirement fund/.test(l.description)).map((l) => l.credit)).toEqual([3000]);
    expect(built.totalDebit).toBe(built.totalCredit);
  });
  it('approved, the certificate data carries the 3817 as non-cash income', async () => {
    await authorisePayRun(call, runId, approver);
    const plan = await call(journalPlan as Route, 'GET', `/api/payroll/runs/${runId}/journal-plan`, runId);
    expect((await call(approve as Route, 'POST', `/api/payroll/runs/${runId}/approve`, runId, { body: { expectedPlanHash: plan.body.data!.planHash } })).statusCode).toBe(200);
    const row = (await getIrp5EmployeeTotals(companyA, 2027, { employeeId: empA })).rows[0]!;
    expect(row.fringeBenefits).toEqual([{ sourceCode: '3817', amount: 3000 }]);
    expect(row.grossSalary).toBe(20000);
  });
});

describe('the approval gate sees a counts_as_rfi switch after calculation', () => {
  it('April: a switch of a component NOT on the line changes nothing; switching the line\'s Basic Salary says recalculate', async () => {
    const runId = await calculatedRun(call, 4);
    expect(await runLinesRefusal(companyA, runId)).toBeNull();
    const second = (await pool.query<{ id: string }>("SELECT id FROM payroll_components WHERE company_id = $1 AND name = 'Second salary'", [companyA])).rows[0]!.id;
    expect((await patch(second, { countsAsRfi: false })).statusCode).toBe(200);
    expect(await runLinesRefusal(companyA, runId)).toBeNull();
    const basic = (await pool.query<{ id: string }>("SELECT id FROM payroll_components WHERE company_id = $1 AND name = 'Basic Salary'", [companyA])).rows[0]!.id;
    // Another audited change of the component (not counts_as_rfi) does not trip it either.
    await pool.query(`INSERT INTO audit_log (company_id, user_id, action, entity_type, entity_id, changes) VALUES ($1, $2, 'update', 'payroll_component', $3,
      '{"fields":[{"field":"name","old":"a","new":"b","label":"Name"}]}'::jsonb)`, [companyA, owner, basic]);
    expect(await runLinesRefusal(companyA, runId)).toBeNull();
    expect((await patch(basic, { countsAsRfi: false })).statusCode).toBe(200);
    expect((await runLinesRefusal(companyA, runId))?.code).toBe('components_changed_after_calculation');
    expect((await patch(basic, { countsAsRfi: true })).statusCode).toBe(200);
  });
});

describe('an assignment from before RF (migration 975 opt-out) keeps its cash treatment and net pay', () => {
  it('June: a fixed 3817 marked employer_fund_as_cash is cash pay, taxed, not deemed, and warned with how to switch', async () => {
    await pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to, employer_fund_as_cash)
       VALUES ($1, $2, 1000, '2026-06-01', '2026-06-30', true)`, [empA, erComponent]);
    const runId = await calculatedRun(call, 6);
    const line = (await pool.query<{ gross_pay: string; retirement_contributions: string; component_breakdown: Array<Record<string, unknown>>; validation_results: Array<{ code: string }> }>(
      'SELECT gross_pay, retirement_contributions, component_breakdown, validation_results FROM payroll_run_lines WHERE run_id = $1', [runId])).rows[0]!;
    // 20 000 salary + the 1 000 kept as cash; the % row (3 000) is still the non-cash, deemed one.
    expect(Number(line.gross_pay)).toBe(21000);
    expect(Number(line.retirement_contributions)).toBe(7000);
    const kept = line.component_breakdown.filter((b) => b.sarsSourceCode === '3817' && b.amount === 1000);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.isNonCash).toBeUndefined();
    expect(line.validation_results.map((v) => v.code)).toContain('EMPLOYER_FUND_KEPT_AS_CASH');
  });
});

describe('the run grid never writes an amount onto a percent row (round 1 L)', () => {
  it('July: writeRunRow on the 15% row is a 400 refusal, not the CHECK 500, and the row is unchanged', async () => {
    const runId = await calculatedRun(call, 7);
    const row = (await pool.query<{ id: string }>(
      'SELECT id FROM payroll_employee_components WHERE employee_id = $1 AND percent_of_rfi IS NOT NULL', [empA])).rows[0]!.id;
    await expect(writeRunRow({
      companyId: companyA, runId, employeeId: empA, componentId: erComponent, componentType: 'earning', period: { year: 2026, month: 7 },
      rowId: row, amount: 100, clear: false, quantity: null, actor: { userId: owner, channel: 'service' },
    })).rejects.toMatchObject({ status: 400 });
    const after = (await pool.query<{ amount: string }>('SELECT amount FROM payroll_employee_components WHERE id = $1', [row])).rows[0]!;
    expect(Number(after.amount)).toBe(0);
  });
});
