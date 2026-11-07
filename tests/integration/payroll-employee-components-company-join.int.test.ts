/**
 * Wave 4 B: an employee's component list joins payroll_components only inside the caller's company. A stray assignment
 * that points at another company's component (bad data, or a copied id) is not listed, so its is_taxable cannot make
 * the readiness card say "Ready to pay". Real Postgres, through the real route; the caller is a member of both
 * companies, so RLS alone would let the other company's component through.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import components from '../../pages/api/payroll/employees/[id]/components';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const companyA = crypto.randomUUID();
const companyB = crypto.randomUUID();
const owner = crypto.randomUUID();
let call: ReturnType<typeof routeCaller>;
let employeeA = '';
let ownComponent = '';
let foreignComponent = '';

const component = async (companyId: string, name: string, taxable: boolean) =>
  (await pool.query<{ id: string }>(
    `INSERT INTO payroll_components (company_id, name, sars_source_code, component_type, is_taxable)
     VALUES ($1,$2,'3601','earning',$3) RETURNING id`, [companyId, name, taxable])).rows[0]!.id;

beforeAll(async () => {
  for (const [id, name] of [[companyA, 'Join A'], [companyB, 'Join B']] as const) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
    await seedPayrollCompany(pool, id);
  }
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [owner, `${owner}@test.local`]);
  for (const id of [companyA, companyB]) await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner')", [id, owner]);
  const token = await new SignJWT({ sub: owner, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  call = routeCaller({ [owner]: token }, { user: owner, company: companyA });
  ownComponent = await component(companyA, 'Join own salary', true);
  foreignComponent = await component(companyB, 'Join foreign wage', false);
  employeeA = (await pool.query<{ id: string }>(
    `INSERT INTO payroll_employees (company_id, employee_number, first_name, last_name, employment_type, start_date)
     VALUES ($1,'JOIN-1','Thandi','Nkosi','permanent','2020-01-01') RETURNING id`, [companyA])).rows[0]!.id;
  for (const c of [ownComponent, foreignComponent]) {
    await pool.query(
      `INSERT INTO payroll_employee_components (employee_id, component_id, amount, effective_from)
       VALUES ($1,$2,1000,'2020-01-01')`, [employeeA, c]);
  }
});

afterAll(async () => {
  try {
    await cleanPayrollCompanies(pool, [companyA, companyB]);
    await pool.query('DELETE FROM users WHERE id = $1', [owner]);
  } finally { await pool.end(); }
});

describe('GET /api/payroll/employees/[id]/components', () => {
  it("lists the company's own component with its taxable flag, and never another company's", async () => {
    const out = await call(components as Route, 'GET', `/api/payroll/employees/${employeeA}/components`, employeeA);
    expect(out.statusCode, JSON.stringify(out.body)).toBe(200);
    const rows = out.body.data as unknown as Array<{ componentId: string; isTaxable: boolean }>;
    expect(rows.map(r => r.componentId)).toEqual([ownComponent]);
    expect(rows[0]!.isTaxable).toBe(true);
  });
});
