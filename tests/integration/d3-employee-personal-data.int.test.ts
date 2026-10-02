/**
 * D3 round 3 — employee personal data (ID / tax / passport / bank numbers, date of birth, pay history,
 * leave balances, training cost) is for write roles. A viewer sees names only. Real withAuth chain, real
 * handlers, real Postgres (disposable fixture). Every route gated or stripped is here, viewer and owner;
 * the aggregate-only routes are pinned too, so one that starts returning a person fails here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import duplicates from '../../pages/api/payroll/duplicates';
import employeesIndex from '../../pages/api/payroll/employees';
import employeeDetail from '../../pages/api/payroll/employees/[id]';
import history from '../../pages/api/payroll/employees/[id]/history';
import costAllocations from '../../pages/api/payroll/employees/[id]/cost-allocations';
import bulkPreview from '../../pages/api/payroll/employees/bulk/preview';
import leaveBalances from '../../pages/api/payroll/leave/balances';
import leaveIndex from '../../pages/api/payroll/leave';
import trainingIndex from '../../pages/api/payroll/training-events';
import wspAtr from '../../pages/api/payroll/training-events/wsp-atr';
import costCentreSummary from '../../pages/api/payroll/runs/[id]/cost-centre-summary';
import taxDirectives from '../../pages/api/accounting/tax-directives';
import importsIndex from '../../pages/api/payroll/parallel-run/imports';
import batchesIndex from '../../pages/api/payroll/batches';
import reconciliation from '../../pages/api/payroll/emp501/reconciliation';
import uifIndex from '../../pages/api/payroll/uif';
import yearEnd from '../../pages/api/payroll/year-end/status';
import eea2 from '../../pages/api/payroll/equity/eea2';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { calculatedRun, cleanPayrollCompanies, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';
import { routeCaller } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const owner = crypto.randomUUID();
const viewer = crypto.randomUUID();
const tokens: Record<string, string> = {};
const call = routeCaller(tokens, { user: owner, company });
const sign = (sub: string) => new SignJWT({ sub, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
const SA_ID = '8001015009087';
const TAX = '0123456789';
let runId = '';
let employeeId = '';

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'D3 personal data']);
  await seedPayrollCompany(pool, company);
  for (const [u, role] of [[owner, 'owner'], [viewer, 'viewer']] as const) {
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [u, `${u}@test.local`]);
    tokens[u] = await sign(u);
    await pool.query('INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,$3)', [company, u, role]);
  }
  employeeId = (await pool.query<{ id: string }>('SELECT id FROM payroll_employees WHERE company_id = $1', [company])).rows[0]!.id;
  // A second employee sharing the ID number makes `duplicates` return it; a history row gives `history` a body.
  await pool.query("UPDATE payroll_employees SET id_number = $2, department = 'Ops' WHERE id = $1", [employeeId, SA_ID]);
  await pool.query(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, start_date, date_of_birth, id_number)
     VALUES ($1, 'D3-2', 'Dup', 'Licate', '2021-01-01', '1985-05-05', $2)`, [company, SA_ID]);
  await pool.query(
    `INSERT INTO payroll_employee_history (company_id, employee_id, field_name, old_value, new_value, effective_from)
     VALUES ($1, $2, 'department', 'Sales', 'Ops', '2026-01-01')`, [company, employeeId]);
  runId = await calculatedRun(call, 3);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM payroll_employee_history WHERE company_id = $1', [company]);
    await cleanPayrollCompanies(pool, [company]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[owner, viewer]]);
  } finally { await pool.end(); }
});

async function raw(route: Route, method: string, query: Record<string, unknown>, user: string, body?: unknown) {
  const req = request({ 'sb-access-token': tokens[user]!, active_company_id: company }, method) as never as { url: string; query: Record<string, unknown>; body: unknown };
  req.url = '/api/x';
  req.query = query;
  req.body = body;
  const out = response();
  await route(req as never, out.res as never);
  return { status: out.state.statusCode, json: JSON.stringify(out.state.body ?? '') };
}

const gated: Array<[string, Route, string, () => Record<string, unknown>, unknown?]> = [
  ['payroll/duplicates', duplicates as Route, 'GET', () => ({})],
  ['employees/[id]/history', history as Route, 'GET', () => ({ id: employeeId })],
  ['employees/[id]/cost-allocations', costAllocations as Route, 'GET', () => ({ id: employeeId })],
  ['employees/bulk/preview', bulkPreview as Route, 'POST', () => ({}), { filter: { department: 'Ops' }, update: { department: 'Admin' } }],
  ['leave/balances', leaveBalances as Route, 'GET', () => ({ year: '2026' })],
  ['leave (list)', leaveIndex as Route, 'GET', () => ({})],
  ['training-events (list)', trainingIndex as Route, 'GET', () => ({})],
  ['training-events/wsp-atr', wspAtr as Route, 'GET', () => ({ year: '2026' })],
  ['runs/[id]/cost-centre-summary', costCentreSummary as Route, 'GET', () => ({ id: runId })],
  ['accounting/tax-directives', taxDirectives as Route, 'GET', () => ({})],
];

describe('per-employee personal data — viewer 403, write role served', () => {
  it.each(gated)('%s: a viewer gets 403 and no personal data', async (_n, route, method, query, body) => {
    const r = await raw(route, method, query(), viewer, body);
    expect(r.status).toBe(403);
    expect(r.json).not.toMatch(new RegExp(`${SA_ID}|Wanda|Licate`));
  });
  it.each(gated)('%s: an owner is not refused', async (_n, route, method, query, body) => {
    expect((await raw(route, method, query(), owner, body)).status).not.toBe(403);
  });
  it('duplicates: an owner sees the shared ID number; bulk preview does not write', async () => {
    expect((await raw(duplicates as Route, 'GET', {}, owner)).json).toContain(SA_ID);
    expect(Number((await pool.query<{ n: string }>("SELECT count(*) AS n FROM payroll_employees WHERE company_id = $1 AND department = 'Admin'", [company])).rows[0]!.n)).toBe(0);
  });
});

describe('employees list + detail — a viewer gets names only, server side', () => {
  const PERSONAL = ['idNumber', 'taxNumber', 'dateOfBirth', 'startDate', 'endDate', 'medicalAid', 'uifExcluded', 'costCentreId', 'payScaleId', 'occupationalLevelId'];
  it('list: viewer rows carry id, employee number, names, employment type and nothing personal', async () => {
    const v = await raw(employeesIndex as Route, 'GET', {}, viewer);
    expect(v.status).toBe(200);
    const rows = (JSON.parse(v.json) as { data: Array<Record<string, unknown>> }).data;
    expect(rows.map((r) => r.firstName)).toContain('Wanda');
    for (const row of rows) for (const k of PERSONAL) expect(Object.keys(row).some((x) => x.startsWith(k))).toBe(false);
    expect(v.json).not.toContain(SA_ID);
    expect(v.json).not.toContain(TAX);
  });
  it('list: an owner still gets the full row', async () => {
    const o = await raw(employeesIndex as Route, 'GET', {}, owner);
    expect(o.json).toContain(SA_ID);
    expect(o.json).toContain(TAX);
  });
  it('detail: viewer gets names only; owner gets the full row', async () => {
    const v = await raw(employeeDetail as Route, 'GET', { id: employeeId }, viewer);
    expect(v.status).toBe(200);
    expect(v.json).toContain('Wanda');
    expect(v.json).not.toContain(SA_ID);
    expect(v.json).not.toContain(TAX);
    expect(v.json).not.toContain('dateOfBirth');
    const o = await raw(employeeDetail as Route, 'GET', { id: employeeId }, owner);
    expect(o.json).toContain(SA_ID);
    expect(o.json).toContain('dateOfBirth');
  });
});

describe('aggregate-only routes — a viewer may read them and they carry no person', () => {
  const agg: Array<[string, Route, Record<string, unknown>]> = [
    ['parallel-run/imports (list)', importsIndex as Route, {}],
    ['batches (list)', batchesIndex as Route, {}],
    ['emp501/reconciliation', reconciliation as Route, { taxYear: '2027' }],
    ['uif (list)', uifIndex as Route, { year: '2026' }],
    ['year-end/status', yearEnd as Route, { taxYear: '2027' }],
    ['equity/eea2', eea2 as Route, {}],
  ];
  it.each(agg)('%s: 200 for a viewer, no name / ID / tax number', async (_n, route, query) => {
    const r = await raw(route, 'GET', query, viewer);
    expect(r.status).toBe(200);
    expect(r.json).not.toMatch(new RegExp(`Wanda|Licate|${SA_ID}|${TAX}`));
  });
});
