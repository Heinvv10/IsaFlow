/**
 * Wave 5 FB: /api/payroll/employees/:id/fringe-benefits. Real withAuth chain, real handler, real Postgres
 * (disposable fixture only). A viewer is refused and writes nothing; another company's employee is 404; a refused
 * body writes nothing; a month a paid run read cannot change; every answer is no-store.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import fringe from '../../pages/api/payroll/employees/[id]/fringe-benefits';
import approve from '../../pages/api/payroll/runs/[id]/approve';
import journalPlan from '../../pages/api/payroll/runs/[id]/journal-plan';
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
