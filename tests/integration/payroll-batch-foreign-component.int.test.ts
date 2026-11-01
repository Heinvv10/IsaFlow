/**
 * A payroll batch cannot carry another company's component, through the real routes and a real Postgres. The foreign
 * key is not tenant-aware and it bypasses RLS, so a user in company A alone could name B's component as easily as a
 * user in both. Only the company check keeps it out. postBatch checks again: a batch stored before createBatch did
 * would otherwise still write the foreign component onto A's employees.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import batches from '../../pages/api/payroll/batches';
import post from '../../pages/api/payroll/batches/[id]/post';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const companyA = crypto.randomUUID();
const companyB = crypto.randomUUID();
const aOnly = crypto.randomUUID();
const both = crypto.randomUUID();
let call: ReturnType<typeof routeCaller>;
let componentA = '';
let componentB = '';
let employeeA = '';

const firstId = async (table: string, companyId: string) =>
  (await pool.query<{ id: string }>(`SELECT id FROM ${table} WHERE company_id = $1 LIMIT 1`, [companyId])).rows[0]!.id;
const batchRows = async (companyId: string, description: string) => (await pool.query(
  'SELECT id FROM payroll_batches WHERE company_id = $1 AND description = $2', [companyId, description])).rows;
const create = (user: string, company: string, componentId: string, description: string, batchType = 'component_values') =>
  call(batches as Route, 'POST', '/api/payroll/batches', undefined, {
    user, company, body: { batchType, componentId, description, periodYear: 2026, periodMonth: 11 },
  });

beforeAll(async () => {
  for (const [id, name] of [[companyA, 'Batch tenant A'], [companyB, 'Batch tenant B']] as const) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
    await seedPayrollCompany(pool, id);
  }
  for (const id of [aOnly, both]) {
    await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [id, `${id}@test.local`]);
  }
  for (const [company, user] of [[companyA, aOnly], [companyA, both], [companyB, both]] as const) {
    await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner')", [company, user]);
  }
  const sign = (sub: string) => new SignJWT({ sub, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  call = routeCaller({ [aOnly]: await sign(aOnly), [both]: await sign(both) }, { user: aOnly, company: companyA });
  componentA = await firstId('payroll_components', companyA);
  componentB = await firstId('payroll_components', companyB);
  employeeA = await firstId('payroll_employees', companyA);
});

afterAll(async () => {
  try {
    const ids = [companyA, companyB];
    await pool.query('DELETE FROM payroll_batch_lines WHERE batch_id IN (SELECT id FROM payroll_batches WHERE company_id = ANY($1))', [ids]);
    await pool.query('DELETE FROM payroll_batches WHERE company_id = ANY($1)', [ids]);
    await cleanPayrollCompanies(pool, ids);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[aOnly, both]]);
  } finally { await pool.end(); }
});

describe('POST /api/payroll/batches', () => {
  it.each([
    ['a user in company A only', () => aOnly],
    ['a user in both companies', () => both],
  ])("%s: another company's component is a 400, the reason is said, and no batch exists", async (name, user) => {
    const out = await create(user(), companyA, componentB, `foreign ${name}`);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(out.body.error?.message).toMatch(/not found in this company/i);
    expect(await batchRows(companyA, `foreign ${name}`)).toEqual([]);
  });

  it('a travel batch has no use for a component, and still cannot hold a foreign one', async () => {
    const out = await create(aOnly, companyA, componentB, 'foreign travel', 'reimbursive_travel');
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(await batchRows(companyA, 'foreign travel')).toEqual([]);
  });

  it.each([
    ['a user in company A only', () => aOnly],
    ['a user in both companies', () => both],
  ])("%s: this company's component makes the batch", async (name, user) => {
    const out = await create(user(), companyA, componentA, `own ${name}`);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(201);
    expect(out.body.data!.componentId).toBe(componentA);
  });

  it("the check follows the active company: B's component is fine with B active", async () => {
    const out = await create(both, companyB, componentB, 'own in B');
    expect(out.statusCode, JSON.stringify(out.body)).toBe(201);
  });
});

describe('POST /api/payroll/batches/:id/post', () => {
  it('a batch already holding a foreign component is refused, and nothing reaches the employee', async () => {
    const batch = (await pool.query<{ id: string }>(
      `INSERT INTO payroll_batches (company_id, batch_type, component_id, description, period_year, period_month, status)
       VALUES ($1, 'component_values', $2, 'stored before the check', 2026, 11, 'validated') RETURNING id`,
      [companyA, componentB])).rows[0]!.id;
    await pool.query(
      `INSERT INTO payroll_batch_lines (batch_id, employee_id, value, effective_from) VALUES ($1, $2, 500, '2026-11-01')`,
      [batch, employeeA]);
    const out = await call(post as Route, 'POST', `/api/payroll/batches/${batch}/post`, batch);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(400);
    expect(out.body.error?.message).toMatch(/not found in this company/i);
    const written = await pool.query('SELECT 1 FROM payroll_employee_components WHERE employee_id = $1 AND component_id = $2', [employeeA, componentB]);
    expect(written.rows).toEqual([]);
    const status = await pool.query<{ status: string }>('SELECT status FROM payroll_batches WHERE id = $1', [batch]);
    expect(status.rows[0]!.status).toBe('validated');
  });
});
