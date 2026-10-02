/**
 * D3 round 5 — payroll WRITES a viewer could make (only withCsrf stood in front of them), and the director
 * ID numbers any role could read. Real withAuth chain, real handlers, disposable fixture. Each: viewer 403
 * and nothing written (row counts before/after); owner unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import batches from '../../pages/api/payroll/batches';
import imports from '../../pages/api/payroll/parallel-run/imports';
import payPackages from '../../pages/api/payroll/pay-packages';
import payScales from '../../pages/api/payroll/pay-scales';
import components from '../../pages/api/payroll/components';
import costCentres from '../../pages/api/payroll/cost-centres';
import companyDirectors from '../../pages/api/accounting/company-directors';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { cleanPayrollCompanies, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const owner = crypto.randomUUID();
const viewer = crypto.randomUUID();
const tokens: Record<string, string> = {};
const sign = (sub: string) => new SignJWT({ sub, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
  .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
const DIRECTOR_ID = '7001015009087';

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'D3 write gates']);
  await seedPayrollCompany(pool, company);
  for (const [u, role] of [[owner, 'owner'], [viewer, 'viewer']] as const) {
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [u, `${u}@test.local`]);
    tokens[u] = await sign(u);
    await pool.query('INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,$3)', [company, u, role]);
  }
  await pool.query("INSERT INTO company_directors (company_id, name, id_number, role, id_document_name) VALUES ($1, 'Dee Rector', $2, 'Director', 'id-scan.pdf')", [company, DIRECTOR_ID]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM company_directors WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM payroll_batches WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM payroll_external_payslips WHERE import_id IN (SELECT id FROM payroll_external_imports WHERE company_id = $1)', [company]).catch(() => undefined);
    await pool.query('DELETE FROM payroll_external_imports WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM pay_packages WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM pay_scales WHERE company_id = $1', [company]);
    await pool.query('DELETE FROM cost_centres WHERE company_id = $1', [company]);
    await cleanPayrollCompanies(pool, [company]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[owner, viewer]]);
  } finally { await pool.end(); }
});

async function raw(route: Route, method: string, user: string, body?: unknown) {
  const req = request({ 'sb-access-token': tokens[user]!, active_company_id: company }, method) as never as { url: string; query: Record<string, unknown>; body: unknown };
  req.url = '/api/x';
  req.query = {};
  req.body = body;
  const out = response();
  await route(req as never, out.res as never);
  return { status: out.state.statusCode, json: JSON.stringify(out.state.body ?? '') };
}
const count = async (table: string) => Number((await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE company_id = $1`, [company])).rows[0]!.n);

const CSV = 'employee number,employee name,gross,paye,net\nW301-1,Wanda Test,20000,1800,18000\n';
const writes: Array<[string, Route, string, unknown]> = [
  ['batches', batches as Route, 'payroll_batches', { batchType: 'reimbursive_travel', description: 'D3 batch', periodYear: 2026, periodMonth: 5 }],
  ['parallel-run/imports', imports as Route, 'payroll_external_imports', { csvText: CSV, periodMonth: 5, periodYear: 2026 }],
  ['pay-packages', payPackages as Route, 'pay_packages', { code: 'D3P', name: 'D3 package' }],
  ['pay-scales', payScales as Route, 'pay_scales', { code: 'D3S', name: 'D3 scale', gradeLevel: 1, minSalary: 100, midSalary: 200, maxSalary: 300 }],
  ['components', components as Route, 'payroll_components', { name: 'D3 Allowance', sarsSourceCode: '3713', componentType: 'earning' }],
  ['cost-centres', costCentres as Route, 'cost_centres', { code: 'D3CC', name: 'D3 centre' }],
];

describe('POST — a viewer is refused and nothing is written; an owner is served', () => {
  it.each(writes)('%s', async (_n, route, table, body) => {
    const before = await count(table);
    const v = await raw(route, 'POST', viewer, body);
    expect(v.status, v.json).toBe(403);
    expect(await count(table)).toBe(before);
    const o = await raw(route, 'POST', owner, body);
    expect(o.status, o.json).toBe(201);
    expect(await count(table)).toBe(before + 1);
  });
  it.each(writes)('%s: GET stays open to a viewer', async (_n, route) => {
    expect((await raw(route, 'GET', viewer)).status).toBe(200);
  });
});

describe('company-directors GET — identifiers for write roles only', () => {
  it('viewer: name and role, no ID number, no ID document name', async () => {
    const v = await raw(companyDirectors as Route, 'GET', viewer);
    expect(v.status).toBe(200);
    expect(v.json).toContain('Dee Rector');
    expect(v.json).not.toMatch(new RegExp(`${DIRECTOR_ID}|idNumber|id-scan|idDocumentName`));
  });
  it('owner: the full row', async () => {
    const o = await raw(companyDirectors as Route, 'GET', owner);
    expect(o.json).toContain(DIRECTOR_ID);
    expect(o.json).toContain('id-scan.pdf');
  });
});
