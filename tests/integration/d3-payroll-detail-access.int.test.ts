/**
 * D3 — per-employee payroll figures are for the roles that can calculate and
 * approve a run. A viewer sees run TOTALS (the runs list) and gets 403 on every
 * route that carries one person's pay; a viewer also cannot create a run (it
 * takes the month and there is no delete). Real withAuth chain, real handlers,
 * real Postgres (disposable fixture only).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import runsIndex from '../../pages/api/payroll/runs';
import runDetail from '../../pages/api/payroll/runs/[id]';
import variance from '../../pages/api/payroll/runs/[id]/variance';
import cashRegister from '../../pages/api/payroll/runs/[id]/cash-register';
import journalPlan from '../../pages/api/payroll/runs/[id]/journal-plan';
import approve from '../../pages/api/payroll/runs/[id]/approve';
import irp5Summary from '../../pages/api/payroll/irp5/summary';
import irp5Export from '../../pages/api/payroll/irp5/easyfile-export';
import emp501Export from '../../pages/api/payroll/emp501/export';
import components from '../../pages/api/payroll/employees/[id]/components';
import termination from '../../pages/api/payroll/employees/[id]/termination';
import loansIndex from '../../pages/api/payroll/loans';
import uifDetail from '../../pages/api/payroll/uif/[id]';
import batchDetail from '../../pages/api/payroll/batches/[id]';
import parallelCompare from '../../pages/api/payroll/parallel-run/compare';
import parallelExport from '../../pages/api/payroll/parallel-run/export';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { calculatedRun, cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const owner = crypto.randomUUID();
const viewer = crypto.randomUUID();
const tokens: Record<string, string> = {};
const call = routeCaller(tokens, { user: owner, company });
const sign = (sub: string) => new SignJWT({ sub, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
let runId = '';
let employeeId = '';

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'D3 payroll detail access']);
  await seedPayrollCompany(pool, company);
  for (const [u, role] of [[owner, 'owner'], [viewer, 'viewer']] as const) {
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [u, `${u}@test.local`]);
    tokens[u] = await sign(u);
    await pool.query('INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,$3)', [company, u, role]);
  }
  runId = await calculatedRun(call, 3);
  employeeId = (await pool.query<{ id: string }>('SELECT id FROM payroll_employees WHERE company_id = $1', [company])).rows[0]!.id;
});

afterAll(async () => {
  try {
    await cleanPayrollCompanies(pool, [company]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[owner, viewer]]);
  } finally { await pool.end(); }
});

const headers = (month: number) => pool.query<{ n: string }>(
  'SELECT count(*) AS n FROM payroll_run_headers WHERE company_id = $1 AND period_month = $2', [company, month]);

describe('POST /api/payroll/runs — write roles only', () => {
  it('a viewer gets 403 and no run is written', async () => {
    const r = await call(runsIndex as Route, 'POST', '/api/payroll/runs', undefined, { user: viewer, body: { month: 4, year: 2026 } });
    expect(r.statusCode).toBe(403);
    expect((await headers(4)).rows[0]!.n).toBe('0');
  });
  it('an owner creates the run as before', async () => {
    const r = await call(runsIndex as Route, 'POST', '/api/payroll/runs', undefined, { body: { month: 5, year: 2026 } });
    expect(r.statusCode).toBe(201);
    expect((await headers(5)).rows[0]!.n).toBe('1');
  });
});

describe('the runs list keeps its totals for a viewer', () => {
  it('GET /api/payroll/runs is 200 for a viewer, run totals and no employee lines', async () => {
    const r = await call(runsIndex as Route, 'GET', '/api/payroll/runs', undefined, { user: viewer });
    expect(r.statusCode).toBe(200);
    const row = (r.body.data as unknown as Array<Record<string, unknown>>).find((x) => x.id === runId)!;
    expect(Number(row.totalGross)).toBe(20000);
    expect(JSON.stringify(r.body)).not.toMatch(/Wanda|lines/);
  });
});

describe('per-employee detail — viewer 403, write role served', () => {
  const routes: Array<[string, Route, () => { url: string; id?: string }]> = [
    ['runs/[id]', runDetail as Route, () => ({ url: `/api/payroll/runs/${runId}`, id: runId })],
    ['runs/[id]/variance', variance as Route, () => ({ url: `/api/payroll/runs/${runId}/variance`, id: runId })],
    ['runs/[id]/cash-register', cashRegister as Route, () => ({ url: `/api/payroll/runs/${runId}/cash-register`, id: runId })],
    ['irp5/summary', irp5Summary as Route, () => ({ url: '/api/payroll/irp5/summary?taxYear=2026' })],
    ['irp5/easyfile-export', irp5Export as Route, () => ({ url: '/api/payroll/irp5/easyfile-export?taxYear=2026' })],
    ['emp501/export', emp501Export as Route, () => ({ url: '/api/payroll/emp501/export?taxYear=2026' })],
    ['employees/[id]/components', components as Route, () => ({ url: `/api/payroll/employees/${employeeId}/components`, id: employeeId })],
    ['employees/[id]/termination', termination as Route, () => ({ url: `/api/payroll/employees/${employeeId}/termination`, id: employeeId })],
    ['loans', loansIndex as Route, () => ({ url: '/api/payroll/loans' })],
    ['uif/[id]', uifDetail as Route, () => ({ url: `/api/payroll/uif/${crypto.randomUUID()}`, id: crypto.randomUUID() })],
    ['batches/[id]', batchDetail as Route, () => ({ url: `/api/payroll/batches/${crypto.randomUUID()}`, id: crypto.randomUUID() })],
    ['parallel-run/compare', parallelCompare as Route, () => ({ url: `/api/payroll/parallel-run/compare?importId=${crypto.randomUUID()}` })],
    ['parallel-run/export', parallelExport as Route, () => ({ url: `/api/payroll/parallel-run/export?importId=${crypto.randomUUID()}` })],
  ];

  it.each(routes)('%s: a viewer gets 403', async (_name, route, target) => {
    const { url, id } = target();
    const r = await call(route, 'GET', url, id, { user: viewer });
    expect(r.statusCode).toBe(403);
    expect(JSON.stringify(r.body)).not.toMatch(/Wanda|grossPay|netPay/);
  });

  it.each(routes)('%s: an owner is not refused by the gate', async (_name, route, target) => {
    const { url, id } = target();
    const r = await call(route, 'GET', url, id);
    expect(r.statusCode).not.toBe(403);
  });

  it('runs/[id]: an owner gets the full lines, a viewer gets none of them', async () => {
    const o = await call(runDetail as Route, 'GET', `/api/payroll/runs/${runId}`, runId);
    const lines = o.body.data!.lines as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(1);
    expect(Number(lines[0]!.netPay)).toBeGreaterThan(0);
    const v = await call(runDetail as Route, 'GET', `/api/payroll/runs/${runId}`, runId, { user: viewer });
    expect(v.statusCode).toBe(403);
    expect(v.body.data).toBeUndefined();
  });

  it('a viewer still cannot reach detail of a run that does not exist (403 before 404)', async () => {
    const r = await call(runDetail as Route, 'GET', '/x', crypto.randomUUID(), { user: viewer });
    expect(r.statusCode).toBe(403);
  });
  it('an owner gets 404 for a run that does not exist', async () => {
    const r = await call(runDetail as Route, 'GET', '/x', crypto.randomUUID());
    expect(r.statusCode).toBe(404);
  });
});

describe('journal-plan preview — one blocker answer', () => {
  it('sends the top-level blocker and planHash but not the plan\'s raw blockers; the hash still approves', async () => {
    const r = await call(journalPlan as Route, 'GET', `/api/payroll/runs/${runId}/journal-plan`, runId);
    expect(r.statusCode).toBe(200);
    expect(r.body.data).toHaveProperty('blocker', null);
    expect(r.body.data!.plan).not.toHaveProperty('blockers');
    const a = await call(approve as Route, 'POST', `/api/payroll/runs/${runId}/approve`, runId, { body: { expectedPlanHash: r.body.data!.planHash } });
    expect(a.statusCode).toBe(200);
  });
});
