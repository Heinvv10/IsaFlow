/**
 * Wave 5 FB: /api/payroll/employees/:id/fringe-benefits. Real withAuth chain, real handler, real Postgres
 * (disposable fixture only). A viewer is refused and writes nothing; another company's employee is 404; a refused
 * body writes nothing; a month a paid run read cannot change; every answer is no-store.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { INTERACTIVE_REPORT_LIMIT } from '../../src/lib/rateLimit';
import { SignJWT } from 'jose';
import fringe from '../../pages/api/payroll/employees/[id]/fringe-benefits';
import calculate from '../../pages/api/payroll/runs/[id]/calculate';
import approve from '../../pages/api/payroll/runs/[id]/approve';
import journalPlan from '../../pages/api/payroll/runs/[id]/journal-plan';
import { getIrp5EmployeeTotals } from '../../src/modules/accounting/services/payroll/irp5DataService';
import { runLinesRefusal } from '../../src/modules/accounting/services/payroll/payrollRunRecalcGate';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { authorisePayRun, calculatedRun, cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const companyA = crypto.randomUUID();
const companyB = crypto.randomUUID();
const owner = crypto.randomUUID();
const approver = crypto.randomUUID();
const viewer = crypto.randomUUID();
const tokens: Record<string, string> = {};
const call = routeCaller(tokens, { user: owner, company: companyA });
const sign = (sub: string) => new SignJWT({ sub, aal: 'aal2', session_id: crypto.randomUUID() }).setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
let juneRun = '';
let empA = '';
let empB = '';

const rows = async (employee: string) => Number((await pool.query<{ n: string }>(
  'SELECT count(*) AS n FROM payroll_employee_fringe_benefits WHERE employee_id = $1', [employee])).rows[0]!.n);
const send = (method: string, body?: unknown, user = owner, id = empA) =>
  call(fringe as Route, method, `/api/payroll/employees/${id}/fringe-benefits`, id, { body, user });
const vehicle = (over: Record<string, unknown> = {}) => ({
  kind: 'company_vehicle', determinedValue: 400000, maintenancePlan: false, businessUseAtLeast80: false, effectiveFrom: '2026-06-01', ...over,
});

beforeAll(async () => {
  for (const [c, name] of [[companyA, 'FB fringe A'], [companyB, 'FB fringe B']] as const) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [c, name]);
    await seedPayrollCompany(pool, c);
  }
  for (const [u, role] of [[owner, 'owner'], [approver, 'owner'], [viewer, 'viewer']] as const) {
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [u, `${u}@test.local`]);
    tokens[u] = await sign(u);
    await pool.query('INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,$3)', [companyA, u, role]);
  }
  empA = (await pool.query<{ id: string }>('SELECT id FROM payroll_employees WHERE company_id = $1', [companyA])).rows[0]!.id;
  empB = (await pool.query<{ id: string }>('SELECT id FROM payroll_employees WHERE company_id = $1', [companyB])).rows[0]!.id;
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM payroll_employee_fringe_benefits WHERE company_id = ANY($1)', [[companyA, companyB]]);
    await cleanPayrollCompanies(pool, [companyA, companyB]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[owner, approver, viewer]]);
  } finally { await pool.end(); }
});

describe('access', () => {
  it('a viewer is refused on read and write, and nothing is written', async () => {
    expect((await send('GET', undefined, viewer)).statusCode).toBe(403);
    expect((await send('POST', vehicle(), viewer)).statusCode).toBe(403);
    expect(await rows(empA)).toBe(0);
  });
  it('company B\'s employee is 404 for company A on GET, POST and PATCH, and nothing is written', async () => {
    expect((await send('GET', undefined, owner, empB)).statusCode).toBe(404);
    expect((await send('POST', { ...vehicle(), kind: 'travel_allowance', determinedValue: null }, owner, empB)).statusCode).toBe(404);
    expect((await send('PATCH', { benefitId: crypto.randomUUID(), effectiveTo: '2026-12-31' }, owner, empB)).statusCode).toBe(404);
    expect(await rows(empB)).toBe(0);
  });
  it('every answer is Cache-Control: no-store', async () => {
    const req = request({ 'sb-access-token': tokens[owner]!, active_company_id: companyA }, 'GET') as never as { url: string; query: Record<string, unknown> };
    req.url = `/api/payroll/employees/${empA}/fringe-benefits`;
    req.query = { id: empA };
    const out = response();
    await (fringe as Route)(req as never, out.res as never);
    expect(out.state.statusCode).toBe(200);
    expect(String(out.headers.get('cache-control'))).toContain('no-store');
  });
});

describe('a refused body writes nothing', () => {
  it('a vehicle with no determined value', async () => {
    const r = await send('POST', vehicle({ determinedValue: null }));
    expect(r.statusCode).toBe(400);
    expect(await rows(empA)).toBe(0);
  });
  it('an unknown field, a bad date and a travel allowance carrying a value', async () => {
    expect((await send('POST', vehicle({ colour: 'red' }))).statusCode).toBe(400);
    expect((await send('POST', vehicle({ effectiveFrom: '01/06/2026' }))).statusCode).toBe(400);
    expect((await send('POST', { kind: 'travel_allowance', determinedValue: 1000, businessUseAtLeast80: true, effectiveFrom: '2026-06-01' })).statusCode).toBe(400);
    expect(await rows(empA)).toBe(0);
  });
  it('a vehicle while the company has no 3802 earning', async () => {
    const r = await send('POST', vehicle());
    expect(r.statusCode).toBe(400);
    expect(String(r.body.error?.message)).toMatch(/3802/);
    expect(await rows(empA)).toBe(0);
  });
});

describe('create, overlap, end', () => {
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable)
       VALUES ($1, 'Company vehicle', '3802', 'earning', true)`, [companyA]);
  });
  let id = '';
  it('records a vehicle', async () => {
    const r = await send('POST', vehicle({ maintenancePlan: true, businessUseAtLeast80: true }));
    expect(r.statusCode).toBe(201);
    id = String(r.body.data!.id);
    expect(r.body.data).toMatchObject({ kind: 'company_vehicle', determinedValue: 400000, maintenancePlan: true, businessUseAtLeast80: true });
    expect(await rows(empA)).toBe(1);
  });
  it('refuses an overlapping benefit of the same kind and writes nothing', async () => {
    expect((await send('POST', vehicle({ effectiveFrom: '2026-09-01' }))).statusCode).toBe(400);
    expect(await rows(empA)).toBe(1);
  });
  it('lists it, and ends it (only ever shortening)', async () => {
    const list = await send('GET');
    expect((list.body.data as unknown as unknown[]).length).toBe(1);
    expect((await send('PATCH', { benefitId: id, effectiveTo: '2026-08-31' })).statusCode).toBe(200);
    expect((await send('PATCH', { benefitId: id, effectiveTo: '2026-12-31' })).statusCode).toBe(400);
    const end = (await pool.query<{ e: string }>("SELECT to_char(effective_to,'YYYY-MM-DD') AS e FROM payroll_employee_fringe_benefits WHERE id = $1", [id])).rows[0]!.e;
    expect(end).toBe('2026-08-31');
  });
  it('writes an audit row the approval gate can read', async () => {
    const n = Number((await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM audit_log WHERE company_id = $1 AND entity_type = 'payroll_fringe_benefit' AND entity_id = $2", [companyA, id])).rows[0]!.n);
    expect(n).toBe(2);
  });
});

describe('a paid month cannot change', () => {
  it('refuses a benefit starting in an approved month, and allows one starting in an unpaid month', async () => {
    const runId = await calculatedRun(call, 3);
    await authorisePayRun(call, runId, approver);
    const plan = await call(journalPlan as Route, 'GET', `/api/payroll/runs/${runId}/journal-plan`, runId);
    const ok = await call(approve as Route, 'POST', `/api/payroll/runs/${runId}/approve`, runId, { body: { expectedPlanHash: plan.body.data!.planHash } });
    expect(ok.statusCode).toBe(200);
    const before = await rows(empA);
    const r = await send('POST', { kind: 'travel_allowance', businessUseAtLeast80: true, effectiveFrom: '2026-03-01' });
    expect(r.statusCode).toBe(400);
    expect(String(r.body.error?.message)).toMatch(/2026-03/);
    expect(await rows(empA)).toBe(before);
    // A later start is fine: April is not paid.
    expect((await send('POST', { kind: 'travel_allowance', businessUseAtLeast80: true, effectiveFrom: '2026-04-01' })).statusCode).toBe(201);
  });
});

describe('a run costs the recorded benefits', () => {
  it('June: travel at 20%, the vehicle as a non-cash 3802 at 20% of 13 000, and the stored line is what the engine derives', async () => {
    const travelComponent = (await pool.query<{ id: string }>(
      `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable)
       VALUES ($1, 'Travel allowance', '3701', 'earning', true) RETURNING id`, [companyA])).rows[0]!.id;
    await pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from) VALUES ($1, $2, 5000, '2026-04-01')`,
      [empA, travelComponent]);
    // The vehicle row was ended 2026-08-31 above: June is inside it (maintenance plan, business use at least 80%).
    const runId = await calculatedRun(call, 6);
    juneRun = runId;
    const line = (await pool.query<{ gross_pay: string; periodic_taxable: string; component_breakdown: Array<Record<string, unknown>> }>(
      'SELECT gross_pay, periodic_taxable, component_breakdown FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [runId, empA])).rows[0]!;
    expect(Number(line.gross_pay)).toBe(25000);
    expect(Number(line.periodic_taxable)).toBe(23600);
    const vehicleItem = line.component_breakdown.find((b) => b.sarsSourceCode === '3802');
    expect(vehicleItem).toMatchObject({ amount: 13000, isNonCash: true, payeInclusionRate: 0.2 });
    expect(line.component_breakdown.find((b) => b.sarsSourceCode === '3701')).toMatchObject({ amount: 5000, payeInclusionRate: 0.2 });
  });
});

describe('the approval gate sees a benefit changed after calculation', () => {
  it('ending the open travel allowance after a run was calculated says recalculate', async () => {
    const runId = await calculatedRun(call, 7);
    expect(await runLinesRefusal(companyA, runId)).toBeNull();
    const open = (await pool.query<{ id: string }>(
      "SELECT id FROM payroll_employee_fringe_benefits WHERE employee_id = $1 AND kind = 'travel_allowance' AND effective_to IS NULL", [empA])).rows[0]!.id;
    expect((await send('PATCH', { benefitId: open, effectiveTo: '2026-12-31' })).statusCode).toBe(200);
    expect((await runLinesRefusal(companyA, runId))?.code).toBe('components_changed_after_calculation');
  });
});

describe('refusals: calendar dates and whole cents (400, never 500)', () => {
  it('a date that is not on the calendar, a value under one cent and a value with a fraction of a cent', async () => {
    const before = await rows(empA);
    expect((await send('POST', { kind: 'travel_allowance', businessUseAtLeast80: true, effectiveFrom: '2026-02-31' })).statusCode).toBe(400);
    expect((await send('POST', { kind: 'travel_allowance', businessUseAtLeast80: true, effectiveFrom: '2027-01-01', effectiveTo: '2027-13-01' })).statusCode).toBe(400);
    expect((await send('PATCH', { benefitId: crypto.randomUUID(), effectiveTo: '2026-06-31' })).statusCode).toBe(400);
    expect((await send('POST', vehicle({ determinedValue: 0.001, effectiveFrom: '2028-01-01' }))).statusCode).toBe(400);
    expect((await send('POST', vehicle({ determinedValue: 400000.005, effectiveFrom: '2028-01-01' }))).statusCode).toBe(400);
    expect(await rows(empA)).toBe(before);
  });
});

describe('the table itself', () => {
  it('refuses a row whose company is not the employee\'s (composite foreign key)', async () => {
    await expect(pool.query(
      `INSERT INTO payroll_employee_fringe_benefits (company_id, employee_id, kind, business_use_at_least_80, effective_from)
       VALUES ($1, $2, 'travel_allowance', false, '2031-01-01')`, [companyB, empA])).rejects.toMatchObject({ code: '23503' });
  });
  it('refuses an overlapping row of one kind even from outside the service (EXCLUDE, where btree_gist exists)', async () => {
    await pool.query(
      `INSERT INTO payroll_employee_fringe_benefits (company_id, employee_id, kind, business_use_at_least_80, effective_from, effective_to)
       VALUES ($1, $2, 'travel_allowance', false, '2032-01-01', '2032-12-31')`, [companyA, empA]);
    await expect(pool.query(
      `INSERT INTO payroll_employee_fringe_benefits (company_id, employee_id, kind, business_use_at_least_80, effective_from, effective_to)
       VALUES ($1, $2, 'travel_allowance', true, '2032-06-01', '2033-06-01')`, [companyA, empA])).rejects.toMatchObject({ code: '23P01' });
  });
  it('lets the app role end a row but not rewrite its value, delete it, or change its dates', async () => {
    const id = (await pool.query<{ id: string }>(
      `INSERT INTO payroll_employee_fringe_benefits (company_id, employee_id, kind, determined_value, effective_from)
       VALUES ($1, $2, 'company_vehicle', 100000, '2034-01-01') RETURNING id`, [companyA, empA])).rows[0]!.id;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [companyA]);
      const attempt = async (sqlText: string) => {
        await client.query('SAVEPOINT a');
        try { await client.query(sqlText, [id]); return 'ok'; } catch (e) { await client.query('ROLLBACK TO SAVEPOINT a'); return (e as { code?: string }).code ?? 'err'; }
      };
      expect(await attempt('UPDATE payroll_employee_fringe_benefits SET determined_value = 1 WHERE id = $1')).toBe('42501');
      expect(await attempt('UPDATE payroll_employee_fringe_benefits SET effective_from = effective_from WHERE id = $1')).toBe('42501');
      expect(await attempt('DELETE FROM payroll_employee_fringe_benefits WHERE id = $1')).toBe('42501');
      await client.query('ROLLBACK');
    } finally { client.release(); }
  });
});

describe('a benefit that cannot be shown blocks approval', () => {
  it('with the 3802 earning switched off, the August line carries the error and the gate says fringe_benefit_not_applied', async () => {
    await pool.query("UPDATE payroll_components SET is_active = false WHERE company_id = $1 AND sars_source_code = '3802'", [companyA]);
    const runId = await calculatedRun(call, 8);
    const refusal = await runLinesRefusal(companyA, runId);
    expect(refusal?.code).toBe('fringe_benefit_not_applied');
    const line = (await pool.query<{ v: Array<{ code: string; severity: string }> }>(
      'SELECT validation_results AS v FROM payroll_run_lines WHERE run_id = $1 AND employee_id = $2', [runId, empA])).rows[0]!.v;
    expect(line).toContainEqual(expect.objectContaining({ code: 'FRINGE_BENEFIT_NOT_APPLIED', severity: 'error' }));
    await pool.query("UPDATE payroll_components SET is_active = true WHERE company_id = $1 AND sars_source_code = '3802'", [companyA]);
  });
});

describe('the certificate data carries 3701 and 4582 from the stored lines', () => {
  it('after June is approved: the allowance under its own code, 4582 = the 20% shares of 3701 and 3802', async () => {
    // The travel row was ended after June was calculated (the gate test above): recalculate, as the gate demands.
    expect((await call(calculate as Route, 'POST', `/api/payroll/runs/${juneRun}/calculate`, juneRun)).statusCode).toBe(200);
    await authorisePayRun(call, juneRun, approver);
    const plan = await call(journalPlan as Route, 'GET', `/api/payroll/runs/${juneRun}/journal-plan`, juneRun);
    expect((await call(approve as Route, 'POST', `/api/payroll/runs/${juneRun}/approve`, juneRun, { body: { expectedPlanHash: plan.body.data!.planHash } })).statusCode).toBe(200);
    const data = await getIrp5EmployeeTotals(companyA, 2027, { employeeId: empA });
    const row = data.rows[0]!;
    expect(row.cashAllowances).toEqual([{ sourceCode: '3701', amount: 5000 }]);
    expect(row.fringeBenefits).toEqual([{ sourceCode: '3802', amount: 13000 }]);
    // 5 000 x 20% + 13 000 x 20%
    expect(row.paye4582).toBe(3600);
    // March 20 000 + June 25 000 cash (the vehicle is non-cash)
    expect(row.grossSalary).toBe(45000);
  });
});

describe('the medical gross-up opt-in', () => {
  it('is recorded like the other kinds, carries no value, and does not overlap itself', async () => {
    const body = { kind: 'medical_gross_up', businessUseAtLeast80: false, effectiveFrom: '2036-01-01' };
    expect((await send('POST', { ...body, determinedValue: 1000 })).statusCode).toBe(400);
    expect((await send('POST', body)).statusCode).toBe(201);
    expect((await send('POST', { ...body, effectiveFrom: '2037-01-01' })).statusCode).toBe(400);
    expect((await send('POST', { ...body, businessUseAtLeast80: true, effectiveFrom: '2040-01-01' })).statusCode).toBe(400);
  });
});

describe('the GET rate limit', () => {
  it('answers 429 once a user passes the interactive limit (the constant the route uses), and a write still succeeds', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < INTERACTIVE_REPORT_LIMIT.max + 5; i += 1) statuses.push((await send('GET', undefined, approver)).statusCode);
    expect(statuses.slice(0, INTERACTIVE_REPORT_LIMIT.max).every((c) => c === 200)).toBe(true);
    expect(statuses.slice(INTERACTIVE_REPORT_LIMIT.max).every((c) => c === 429)).toBe(true);
    const write = await send('POST', { kind: 'travel_allowance', businessUseAtLeast80: true, effectiveFrom: '2038-01-01' }, approver);
    expect(write.statusCode).toBe(201);
  });
});

describe('migration 970 backfills the gross-up opt-in for existing 3810 users, once, inside the window a run can compute', () => {
  const mig = readFileSync(`${__dirname}/../../scripts/migrations/sql/970_payroll_employee_fringe_benefits.sql`, 'utf8');
  const ids: Record<string, string> = {};
  const rowsOf = (id: string) => pool.query<{ kind: string; from: string; to: string | null; by: string }>(
    "SELECT kind, to_char(effective_from,'YYYY-MM-DD') AS from, to_char(effective_to,'YYYY-MM-DD') AS to, created_by AS by FROM payroll_employee_fringe_benefits WHERE employee_id = $1", [id]);
  it('seeds employees and runs the migration; a re-run adds nothing', async () => {
    const comp = (await pool.query<{ id: string }>(
      `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable)
       VALUES ($1, 'Employer medical', '3810', 'earning', true) RETURNING id`, [companyA])).rows[0]!.id;
    const make = async (n: string, rows: Array<[string, string | null]>) => {
      ids[n] = (await pool.query<{ id: string }>(
        `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date) VALUES ($1, $2, 'B', $2, '2020-01-01') RETURNING id`, [companyA, n])).rows[0]!.id;
      for (const [from, to] of rows) {
        await pool.query('INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from, effective_to) VALUES ($1, $2, 2000, $3, $4)', [ids[n], comp, from, to]);
      }
    };
    // companyA's earliest draft or calculated run is July 2026, so the window opens on 2026-07-01.
    await make('BF-ACTIVE', [['2024-05-10', null], ['2025-03-01', null]]);
    await make('BF-HIRE', [['2026-11-20', null]]);
    await make('BF-LEAVER', [['2025-02-10', '2026-11-30']]);
    await make('BF-TWO', [['2025-02-10', '2026-08-15'], ['2026-08-16', '2026-10-31']]);
    await make('BF-ENDED', [['2023-01-01', '2024-12-31']]);
    await make('BF-JUNE', [['2025-01-01', '2026-06-30']]);
    await make('BF-NONE', []);
    await pool.query(mig);
    await pool.query(mig);
  });
  it('an open assignment: from the first of the month it started, open-ended, created by the migration', async () => {
    expect((await rowsOf(ids['BF-ACTIVE']!)).rows).toEqual([{ kind: 'medical_gross_up', from: '2024-05-01', to: null, by: 'migration:970' }]);
  });
  it('a hire on 11-20 stays cash for all of November (the row starts 11-01)', async () => {
    expect((await rowsOf(ids['BF-HIRE']!)).rows).toEqual([{ kind: 'medical_gross_up', from: '2026-11-01', to: null, by: 'migration:970' }]);
  });
  it('a leaver ending 11-30 with November still a draft stays cash: the row ends at that month end', async () => {
    expect((await rowsOf(ids['BF-LEAVER']!)).rows).toEqual([{ kind: 'medical_gross_up', from: '2025-02-01', to: '2026-11-30', by: 'migration:970' }]);
  });
  it('several assignments none open-ended: one row to the month end of the last to end', async () => {
    expect((await rowsOf(ids['BF-TWO']!)).rows).toEqual([{ kind: 'medical_gross_up', from: '2025-02-01', to: '2026-10-31', by: 'migration:970' }]);
  });
  it('assignments that ended before the window, and employees with no 3810, get none; a re-run added no second row', async () => {
    for (const n of ['BF-ENDED', 'BF-JUNE', 'BF-NONE']) expect((await rowsOf(ids[n]!)).rows).toEqual([]);
    expect((await rowsOf(ids['BF-ACTIVE']!)).rows).toHaveLength(1);
  });
  it('the backfilled opt-in is listed on the profile API as medical_gross_up', async () => {
    const r = await send('GET', undefined, owner, ids['BF-ACTIVE']!);
    expect((r.body.data as unknown as Array<{ kind: string }>).map((b) => b.kind)).toEqual(['medical_gross_up']);
  });
});
