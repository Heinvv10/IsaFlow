// RED regression: K-110 — deleting a GL cost centre silently unassigns every
// employee, because payroll_employees.cost_centre_id is ON DELETE SET NULL and
// deleteCostCentre only guards gl_journal_lines.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import costCentresAction from '../../pages/api/accounting/cost-centres-action';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID();
const user = crypto.randomUUID();
const centre = crypto.randomUUID();
const employee = crypto.randomUUID();
let token = '';

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K110 fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [company, user]);
  await pool.query("INSERT INTO cost_centres(id,company_id,code,name,cc_type) VALUES($1,$2,'CC-K110','Ops',$3)", [centre, company, 'cc1']);
  await pool.query(
    `INSERT INTO payroll_employees(id,company_id,employee_number,first_name,last_name,start_date,cost_centre_id)
     VALUES($1,$2,'E-K110','Thandi','Mokoena','2026-01-01',$3)`,
    [employee, company, centre],
  );
  token = await new SignJWT({ sub: user, aal: 'aal2' })
    .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM payroll_employees WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM cost_centres WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM company_users WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('refuses to delete a cost centre that payroll employees are assigned to', async () => {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST') as never as
    { body: unknown; query: Record<string, string>; url: string };
  req.body = { action: 'delete', id: centre };
  req.query = {};
  req.url = '/api/accounting/cost-centres-action';
  const result = response();
  await costCentresAction(req as never, result.res);

  const centres = await pool.query('SELECT id FROM cost_centres WHERE id=$1', [centre]);
  const emp = await pool.query('SELECT cost_centre_id FROM payroll_employees WHERE id=$1', [employee]);
  // RED: today the delete succeeds and the employee's assignment is silently nulled.
  expect({ centreRows: centres.rows.length, employeeCentre: emp.rows[0].cost_centre_id })
    .toEqual({ centreRows: 1, employeeCentre: centre });
});
