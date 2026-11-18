/**
 * Wave 6 DBF through the real routes and real Postgres (disposable fixture only), two tenants: an employer's defined-benefit
 * pension contribution valued per the Seventh Schedule para 12D(3), X = (A x B) - C (the formula's form UNVERIFIED), non-cash
 * and deemed paid by the employee into s11F (PAYE-GEN-01-G21 (2027) Rev 1 p. 10), where the cap binds. #1571 round 2: the row's
 * amount is what the employer pays the fund (GL 2175 and 4472, BRS V25.3.0 p. 103), C is the 4001 marked as the compulsory
 * contribution (an AVC is not C; none marked blocks approval), one factor row per fund kind (409), and a defined_benefit
 * component takes no row without a factor on REST, MCP or the run grid. Company B is costed at 10x the pay in a later month,
 * where X is nil: the employer's payment still reaches 2175, and is not certified as 4472 without a 3817 (BRS p. 54).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import components from '../../pages/api/payroll/components/index';
import component from '../../pages/api/payroll/components/[id]';
import assignments from '../../pages/api/payroll/employees/[id]/components';
import approve from '../../pages/api/payroll/runs/[id]/approve';
import journalPlan from '../../pages/api/payroll/runs/[id]/journal-plan';
import calculate from '../../pages/api/payroll/runs/[id]/calculate';
import irp5Summary from '../../pages/api/payroll/irp5/summary';
import yearEndStatus from '../../pages/api/payroll/year-end/status';
import { assignEmployeeComponentTool } from '../../src/lib/mcp/tools/writeEmployees';
import { employerFundContributionFields } from '../../src/modules/accounting/services/payroll/easyFileRetirementFields';
import { getIrp5EmployeeTotals } from '../../src/modules/accounting/services/payroll/irp5DataService';
import { runLinesRefusal } from '../../src/modules/accounting/services/payroll/payrollRunRecalcGate';
import { writeRunRow } from '../../src/modules/accounting/services/payroll/payrollRunRowWrite';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { authorisePayRun, calculatedRun, cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const A = crypto.randomUUID();
const B = crypto.randomUUID();
const C = crypto.randomUUID(); // a para 12D(6) member with a 4001 (BRS p. 54 readiness)
const owner = crypto.randomUUID();
const approver = crypto.randomUUID();
const tokens: Record<string, string> = {};
const call = routeCaller(tokens, { user: owner, company: A });
const callB = routeCaller(tokens, { user: owner, company: B });
const callC = routeCaller(tokens, { user: owner, company: C });
const sign = (sub: string) => new SignJWT({ sub, aal: 'aal2', session_id: crypto.randomUUID() }).setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
const emp: Record<string, string> = {};
const dbComp: Record<string, string> = {};
const pensionComp: Record<string, string> = {};
const avcComp: Record<string, string> = {};
const row: Record<string, string> = {};

const count = async (text: string, values: unknown[]) => Number((await pool.query<{ n: string }>(text, values)).rows[0]!.n);
const assignmentRows = (co: string) => count(
  'SELECT count(*) AS n FROM payroll_employee_components WHERE employee_id IN (SELECT id FROM payroll_employees WHERE company_id = $1)', [co]);
const create = (co: string, body: Record<string, unknown>) => call(components as Route, 'POST', '/api/payroll/components', undefined, { company: co, body });
const assign = (co: string, body: Record<string, unknown>) => call(assignments as Route, 'POST', `/api/payroll/employees/${emp[co]}/components`, emp[co],
  { company: co, body: { effectiveFrom: '2026-03-01', ...body } });
const mark = (co: string, aid: string, on: unknown) => call(assignments as Route, 'PATCH', `/api/payroll/employees/${emp[co]}/components`, emp[co],
  { company: co, query: { aid }, body: { dbFundMemberContribution: on } });
const recalc = (co: string, runId: string) => call(calculate as Route, 'POST', `/api/payroll/runs/${runId}/calculate`, runId, { company: co });
const approveRun = async (c: typeof call, runId: string) => {
  await authorisePayRun(c, runId, approver);
  const plan = await c(journalPlan as Route, 'GET', `/api/payroll/runs/${runId}/journal-plan`, runId);
  const approved = await c(approve as Route, 'POST', `/api/payroll/runs/${runId}/approve`, runId, { body: { expectedPlanHash: plan.body.data!.planHash } });
  return { plan: plan.body.data as { plan: { totals: { employerRetirement: number } } }, status: approved.statusCode };
};
type Line = { gross_pay: string; paye: string; net_pay: string; retirement_contributions: string; retirement_deduction: string;
  component_breakdown: Array<Record<string, unknown>>; validation_results: Array<{ code: string }>; explanation: { paye: { caution?: string } } };
const lineOf = async (runId: string) => (await pool.query<Line>(
  `SELECT gross_pay, paye, net_pay, retirement_contributions, retirement_deduction, component_breakdown, validation_results, explanation
     FROM payroll_run_lines WHERE run_id = $1`, [runId])).rows[0]!;

beforeAll(async () => {
  for (const [co, name, salary] of [[A, 'DBF A', 20_000], [B, 'DBF B', 200_000], [C, 'DBF C', 20_000]] as const) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [co, name]);
    await seedPayrollCompany(pool, co, salary);
    // The fund's RFI is the basic salary (migration 975's rule for a 3601; the seed writes the component after 975 ran).
    await pool.query("UPDATE payroll_components SET counts_as_rfi = true WHERE company_id = $1 AND sars_source_code = '3601'", [co]);
    emp[co] = (await pool.query<{ id: string }>('SELECT id FROM payroll_employees WHERE company_id = $1', [co])).rows[0]!.id;
  }
  for (const co of [A, B, C]) {
    await pool.query(`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, level)
      VALUES ($1, '2175', 'Other Employee Deductions Payable', 'liability', 'credit', 1)`, [co]);
  }
  for (const u of [owner, approver]) {
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [u, `${u}@example.invalid`]);
    tokens[u] = await sign(u);
    for (const co of [A, B, C]) await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner')", [co, u]);
  }
});

afterAll(async () => {
  try {
    await pool.query("DELETE FROM audit_log WHERE company_id = ANY($1) AND entity_type IN ('payroll_component', 'payroll_employee_component')", [[A, B, C]]);
    await cleanPayrollCompanies(pool, [A, B, C]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[owner, approver]]);
  } finally { await pool.end(); }
});

describe('the components: a defined-benefit pension fund is stored as one; an RA as defined-benefit is not', () => {
  it('creates a 3817 defined-benefit earning (fund_type stored), a 4001 pension and a 4001 AVC in each company', async () => {
    for (const co of [A, B]) {
      const made = await create(co, { name: 'Employer DB pension', sarsSourceCode: '3817', componentType: 'earning', fundType: 'defined_benefit' });
      expect(made.statusCode).toBe(201);
      dbComp[co] = String(made.body.data!.id);
      pensionComp[co] = String((await create(co, { name: 'Pension', sarsSourceCode: '4001', componentType: 'deduction' })).body.data!.id);
      avcComp[co] = String((await create(co, { name: 'Pension AVC', sarsSourceCode: '4001', componentType: 'deduction' })).body.data!.id);
    }
    expect(await count("SELECT count(*) AS n FROM payroll_components WHERE id = $1 AND fund_type = 'defined_benefit'", [dbComp[A]])).toBe(1);
    expect((await create(A, { name: 'RA', sarsSourceCode: '3828', componentType: 'earning', fundType: 'defined_benefit' })).statusCode).toBe(400);
  });
});

describe('assigning: every refusal writes nothing', () => {
  it('refuses a factor beside a percent_of_rfi, on a 4001, a negative amount, once-off, out of range, retired without a factor, or another company\'s component', async () => {
    const before = await assignmentRows(A);
    const refused = [
      { componentId: dbComp[A], amount: 0, dbMemberCategoryFactor: 0.4, percentOfRfi: 0.15 },
      { componentId: pensionComp[A], amount: 0, dbMemberCategoryFactor: 0.4 },
      { componentId: dbComp[A], amount: -1, dbMemberCategoryFactor: 0.4 },
      { componentId: dbComp[A], amount: 0, dbMemberCategoryFactor: 0.4, isRecurring: false },
      { componentId: dbComp[A], amount: 0, dbMemberCategoryFactor: 1.5 },
      { componentId: dbComp[A], amount: 0, dbMemberCategoryFactor: '0.4' },
      { componentId: pensionComp[A], amount: 100, dbMemberRetired: true },
      { componentId: dbComp[B], amount: 0, dbMemberCategoryFactor: 0.4 },
    ];
    for (const b of refused) expect((await assign(A, b)).statusCode, JSON.stringify(b)).toBe(400);
    expect(String((await assign(A, refused[0]!)).body.error?.message)).toMatch(/cannot be on the same assignment/);
    expect(await assignmentRows(A)).toBe(before);
  });

  it('a defined_benefit component without a factor is refused on REST, MCP and the run grid (L3)', async () => {
    const before = await assignmentRows(A);
    const rest = await assign(A, { componentId: dbComp[A], amount: 2200 });
    expect([rest.statusCode, String(rest.body.error?.message)]).toEqual([400, expect.stringMatching(/Defined-benefit fund contributions card/)]);
    const mcp = await assignEmployeeComponentTool.handler({ employee_id: emp[A], component_id: dbComp[A], amount: 2200, effective_from: '2026-03-01',
      idempotency_key: crypto.randomUUID() }, { companyId: A, userId: owner, scopes: ['write:payroll'], companyRole: 'owner', tokenJti: null, oauthAppId: null } as never) as
      { isError?: boolean; content: Array<{ text: string }> };
    expect([mcp.isError, mcp.content[0]!.text]).toEqual([true, expect.stringMatching(/Defined-benefit fund contributions card/)]);
    expect(await assignmentRows(A)).toBe(before);
  });

  it('migration 999s refuses the pair, a negative amount, a factor over 1, retired without a factor, a marked factor row, a bad fund_type', async () => {
    const ins = (cols: string, vals: unknown[]) => pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, effective_from, ${cols}) VALUES ($1, $2, '2026-03-01', ${vals.map((_, i) => `$${i + 3}`).join(', ')})`,
      [emp[A], dbComp[A], ...vals]);
    for (const [cols, vals] of [
      ['amount, db_member_category_factor, percent_of_rfi', [0, 0.4, 0.15]], ['amount, db_member_category_factor', [-1, 0.4]],
      ['amount, db_member_category_factor', [0, 1.5]], ['amount, db_member_retired', [0, true]],
      ['amount, db_member_category_factor, db_fund_member_contribution', [0, 0.4, true]],
    ] as const) await expect(ins(cols, [...vals])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query("UPDATE payroll_components SET fund_type = 'hybrid' WHERE id = $1", [dbComp[A]])).rejects.toMatchObject({ code: '23514' });
  });

  it('stores A: factor 0.40, the employer pays 2 200; pension 1 500 and AVC 1 000. B: factor 0.04, pays 15 000; pension 10 000', async () => {
    const made = await assign(A, { componentId: dbComp[A], amount: 2200, dbMemberCategoryFactor: 0.4 });
    expect([made.statusCode, made.body.data]).toEqual([201, expect.objectContaining({ amount: 2200, dbMemberCategoryFactor: 0.4, dbMemberRetired: false })]);
    row.dbA = String(made.body.data!.id);
    row.pensionA = String((await assign(A, { componentId: pensionComp[A], amount: 1500 })).body.data!.id);
    expect((await assign(A, { componentId: avcComp[A], amount: 1000 })).statusCode).toBe(201);
    expect((await assign(B, { componentId: dbComp[B], amount: 15_000, dbMemberCategoryFactor: 0.04 })).statusCode).toBe(201);
    row.pensionB = String((await assign(B, { componentId: pensionComp[B], amount: 10_000 })).body.data!.id);
  });

  it('a second live factor row of the same kind (another 3817) is a 409 and writes nothing (L1)', async () => {
    const second = String((await create(A, { name: 'Employer DB pension 2', sarsSourceCode: '3817', componentType: 'earning', fundType: 'defined_benefit' })).body.data!.id);
    const before = await assignmentRows(A);
    const res = await assign(A, { componentId: second, amount: 100, dbMemberCategoryFactor: 0.1 });
    expect([res.statusCode, String(res.body.error?.message)]).toEqual([409, expect.stringMatching(/already carries a defined-benefit factor/)]);
    expect(await assignmentRows(A)).toBe(before);
    await pool.query('UPDATE payroll_components SET is_active = false WHERE id = $1', [second]);
  });
});

describe('C is the marked contribution; none marked blocks approval', () => {
  let runA = '';
  it('A, March, none marked: the line carries DB_FUND_MEMBER_CONTRIBUTION_UNMARKED and the gate refuses the run', async () => {
    runA = await calculatedRun(call, 3, { company: A });
    const line = await lineOf(runA);
    expect(line.validation_results.filter((v) => v.code === 'DB_FUND_MEMBER_CONTRIBUTION_UNMARKED')).toHaveLength(1);
    expect((await runLinesRefusal(A, runA))?.code).toBe('db_fund_unsettled');
  });

  it('marking refuses a non-contribution row and another company\'s row; the pension is marked and audited', async () => {
    const salaryRow = (await pool.query<{ id: string }>(
      "SELECT c.id FROM payroll_employee_components c JOIN payroll_components pc ON pc.id = c.component_id WHERE c.employee_id = $1 AND pc.sars_source_code = '3601'", [emp[A]])).rows[0]!.id;
    expect((await mark(A, salaryRow, true)).statusCode).toBe(400);
    expect((await mark(A, row.pensionA!, 'yes')).statusCode).toBe(400);
    expect((await mark(A, row.pensionB!, true)).statusCode).toBe(404);
    expect((await mark(A, row.pensionA!, true)).statusCode).toBe(200);
    expect((await mark(B, row.pensionB!, true)).statusCode).toBe(200);
    expect(await count("SELECT count(*) AS n FROM audit_log WHERE entity_id = $1 AND changes->'metadata'->>'kind' = 'db_fund_contribution_mark'", [row.pensionA])).toBe(1);
    expect((await runLinesRefusal(A, runA))?.code).toBe('components_changed_after_calculation');
  });

  it('A, recalculated: X = 0.40 x 20 000 - 1 500 = 6 500 (the AVC is not C); the employer pays 2 200; the cap binds at 7 287.50', async () => {
    expect((await recalc(A, runA)).statusCode).toBe(200);
    const line = await lineOf(runA);
    expect(line.component_breakdown.find((b) => b.sarsSourceCode === '3817')).toMatchObject({
      amount: 6500, isNonCash: true, dbMemberCategoryFactor: 0.4, rfiBase: 20000, dbEmployeeContribution: 1500, dbEmployerContribution: 2200,
    });
    // PAYE as oracle case db-fund-12d-s11f-cap-binds (1 973.25) less the seed's medical credit (R376): 1 597.25. Contributions
    // 1 500 + 1 000 + 6 500; net 20 000 - 1 500 - 1 000 - 1 597.25 - UIF 177.12.
    expect([line.gross_pay, line.retirement_contributions, line.retirement_deduction, line.paye, line.net_pay].map(Number))
      .toEqual([20000, 9000, 7287.5, 1597.25, 15725.63]);
    expect(line.validation_results.map((v) => v.code)).not.toContain('DB_FUND_MEMBER_CONTRIBUTION_UNMARKED');
    expect(await runLinesRefusal(A, runA)).toBeNull();
  });

  it('A approved: the journal books the 2 200 paid to 2175 (not X); the certificate data says 3817 6 500, 4472 2 200', async () => {
    const { plan, status } = await approveRun(call, runA);
    expect([status, plan.plan.totals.employerRetirement]).toEqual([200, 2200]);
    const fringe = (await getIrp5EmployeeTotals(A, 2027, { employeeId: emp[A] })).rows[0]!.fringeBenefits;
    expect(fringe).toEqual([{ sourceCode: '3817', amount: 6500, employerPaid: 2200 }]);
    expect(employerFundContributionFields(fringe)).toEqual(['4472,2200']);
  });

  it('B, September at 10x: A x B 8 000 < C 10 000, X nil; the 15 000 paid reaches 2175 but not 4472 (BRS p. 54); A is untouched', async () => {
    const runB = await calculatedRun(callB, 9, { company: B });
    const line = await lineOf(runB);
    expect(line.component_breakdown.find((b) => b.sarsSourceCode === '3817')).toMatchObject({ amount: 0, rfiBase: 200000, dbEmployeeContribution: 10000, dbEmployerContribution: 15000 });
    expect(line.validation_results.map((v) => v.code)).toEqual(expect.arrayContaining(['DB_FUND_BENEFIT_NIL', 'DB_FUND_CONTRIBUTION_NOT_CERTIFIED']));
    const { plan, status } = await approveRun(callB, runB);
    expect([status, plan.plan.totals.employerRetirement]).toEqual([200, 15000]);
    const fringe = (await getIrp5EmployeeTotals(B, 2027, { employeeId: emp[B] })).rows[0]!.fringeBenefits;
    expect(fringe).toEqual([{ sourceCode: '3817', amount: 0, employerPaid: 15000 }]);
    expect(employerFundContributionFields(fringe)).toEqual([]);
    expect(Number((await lineOf(runA)).retirement_deduction)).toBe(7287.5);
    expect(await count('SELECT count(*) AS n FROM payroll_run_headers WHERE company_id = $1', [A])).toBe(1);
  });
});

describe('the approval gate and the run grid', () => {
  it('A, May: switching counts_as_rfi on the line\'s salary after calculation says recalculate', async () => {
    const runId = await calculatedRun(call, 5, { company: A });
    expect(await runLinesRefusal(A, runId)).toBeNull();
    const basic = (await pool.query<{ id: string }>("SELECT id FROM payroll_components WHERE company_id = $1 AND name = 'Basic Salary'", [A])).rows[0]!.id;
    const patch = (on: boolean) => call(component as Route, 'PATCH', `/api/payroll/components/${basic}`, basic, { company: A, body: { countsAsRfi: on } });
    expect((await patch(false)).statusCode).toBe(200);
    expect((await runLinesRefusal(A, runId))?.code).toBe('components_changed_after_calculation');
    expect((await patch(true)).statusCode).toBe(200);
  });

  it('A, April: writeRunRow on the defined-benefit row is a 400 and the row keeps its 2 200; inserting the component without a factor is a 400', async () => {
    const runId = await calculatedRun(call, 4, { company: A });
    const w = (rowId: string | null) => writeRunRow({
      companyId: A, runId, employeeId: emp[A], componentId: dbComp[A], componentType: 'earning', period: { year: 2026, month: 4 },
      rowId, amount: 100, clear: false, quantity: null, actor: { userId: owner, channel: 'service' },
    });
    await expect(w(row.dbA!)).rejects.toMatchObject({ status: 400 });
    expect(await count('SELECT count(*) AS n FROM payroll_employee_components WHERE id = $1 AND amount = 2200', [row.dbA])).toBe(1);
    const before = await assignmentRows(A);
    await expect(w(null)).rejects.toMatchObject({ status: 400 });
    expect(await assignmentRows(A)).toBe(before);
  });
});

describe('para 12D(6) member with a 4001: warned at calculate, refused at IRP5 readiness by name (BRS p. 54)', () => {
  it('C, October: the retired row has no value and reports 4585; the line warns DB_FUND_RETIRED_MEMBER_4001; calculate is not refused', async () => {
    const dbC = String((await create(C, { name: 'Employer DB pension', sarsSourceCode: '3817', componentType: 'earning', fundType: 'defined_benefit' })).body.data!.id);
    const penC = String((await create(C, { name: 'Pension', sarsSourceCode: '4001', componentType: 'deduction' })).body.data!.id);
    expect((await assign(C, { componentId: dbC, amount: 2000, dbMemberCategoryFactor: 0.12, dbMemberRetired: true })).statusCode).toBe(201);
    expect((await assign(C, { componentId: penC, amount: 1500 })).statusCode).toBe(201);
    const runC = await calculatedRun(callC, 10, { company: C });
    const line = await lineOf(runC);
    expect(line.component_breakdown.find((b) => b.sarsSourceCode === '3817')).toMatchObject({ amount: 0, dbEmployerContribution: 2000, dbMemberRetired: true });
    expect(line.validation_results.map((v) => v.code)).toEqual(expect.arrayContaining(['DB_FUND_MEMBER_RETIRED', 'DB_FUND_RETIRED_MEMBER_4001']));
    expect((await approveRun(callC, runC)).status).toBe(200);
    const fringe = (await getIrp5EmployeeTotals(C, 2027, { employeeId: emp[C] })).rows[0]!.fringeBenefits;
    expect(fringe).toEqual([{ sourceCode: '3817', amount: 0, employerPaid: 0, retiredMemberPaid: 2000 }]);
  });

  it('the IRP5 summary names the employee with IRP5_DB_RETIRED_MEMBER_4001 (error); the year-end status counts it; A has none', async () => {
    const name = (await pool.query<{ n: string }>("SELECT first_name || ' ' || last_name AS n FROM payroll_employees WHERE id = $1", [emp[C]])).rows[0]!.n;
    const sum = await callC(irp5Summary as Route, 'GET', '/api/payroll/irp5/summary', undefined, { company: C, query: { taxYear: '2027' } });
    expect(sum.statusCode).toBe(200);
    const row = (sum.body.data as { employees: Array<{ employeeId: string; status: string; messages: Array<{ code: string; severity: string; message: string }> }> })
      .employees.find((e) => e.employeeId === emp[C])!;
    const msg = row.messages.find((m) => m.code === 'IRP5_DB_RETIRED_MEMBER_4001');
    expect([msg?.severity, msg?.message.startsWith(`${name}: a retired defined-benefit fund member`), msg?.message.includes('"4001 must be zero"')]).toEqual(['error', true, true]);
    // C has one employee: the year-end count is that row's errors, this one included (the fixture's SARS code table is empty,
    // so IRP5_UNKNOWN_CODE errors sit beside it in both).
    const errors = row.messages.filter((m) => m.severity === 'error');
    expect(errors.filter((m) => m.code === 'IRP5_DB_RETIRED_MEMBER_4001')).toHaveLength(1);
    const status = await callC(yearEndStatus as Route, 'GET', '/api/payroll/year-end/status', undefined, { company: C, query: { taxYear: '2027' } });
    expect((status.body.data as { readiness: { errors: number } }).readiness.errors).toBe(errors.length);
    const sumA = await call(irp5Summary as Route, 'GET', '/api/payroll/irp5/summary', undefined, { company: A, query: { taxYear: '2027' } });
    expect(JSON.stringify(sumA.body.data)).not.toContain('IRP5_DB_RETIRED_MEMBER_4001');
  });
});
