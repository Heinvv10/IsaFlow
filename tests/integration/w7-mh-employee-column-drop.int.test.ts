/**
 * Wave 7 MH (W21), real Postgres: migration 1055 dropped payroll_employees.tax_directive_number. The column is absent
 * from information_schema, and an employee created through the real route round-trips through the row mapper (SELECT *
 * then mapPayrollEmployeeRow) with no key for it. Two tenants: the second company's employee is not in the first's list.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import employees from '../../pages/api/payroll/employees';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { cleanPayrollCompanies, routeCaller, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';
import { mapPayrollEmployeeRow } from '@/modules/accounting/services/payroll/payrollEmployeeService';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const A = crypto.randomUUID();
const B = crypto.randomUUID();
const owner = crypto.randomUUID();
let callA: ReturnType<typeof routeCaller>;
let token: string;

beforeAll(async () => {
  for (const [id, name] of [[A, 'MH drop A'], [B, 'MH drop B']] as const) {
    await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [id, name]);
    await seedPayrollCompany(pool, id);
  }
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [owner, `${owner}@test.local`]);
  for (const id of [A, B]) await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner')", [id, owner]);
  token = await new SignJWT({ sub: owner, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
  callA = routeCaller({ [owner]: token }, { user: owner, company: A });
});

afterAll(async () => {
  try {
    await cleanPayrollCompanies(pool, [A, B]);
    await pool.query('DELETE FROM users WHERE id = $1', [owner]);
  } finally { await pool.end(); }
});

describe('migration 1055: payroll_employees.tax_directive_number is gone', () => {
  it('the column is absent from information_schema', async () => {
    const { rows } = await pool.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'payroll_employees' AND column_name = 'tax_directive_number'`);
    expect(rows).toEqual([]);
  });

  it('an employee created through the route round-trips through the row mapper', async () => {
    const out = await callA(employees as Route, 'POST', '/api/payroll/employees', undefined, {
      body: { firstName: 'Thandi', lastName: 'Nkosi', employeeNumber: 'MH-1', employmentType: 'permanent', startDate: '2026-11-01' },
    });
    expect(out.statusCode, JSON.stringify(out.body)).toBe(201);
    const { rows } = await pool.query('SELECT * FROM payroll_employees WHERE company_id = $1 AND employee_number = $2', [A, 'MH-1']);
    expect(rows).toHaveLength(1);
    const mapped = mapPayrollEmployeeRow(rows[0]);
    expect(mapped).toMatchObject({ firstName: 'Thandi', lastName: 'Nkosi', employeeNumber: 'MH-1' });
    expect(Object.keys(mapped).some((k) => /directive/i.test(k))).toBe(false);
  });

  it("another company's employee list does not include it", async () => {
    const callB = routeCaller({ [owner]: token }, { user: owner, company: B });
    const made = await callB(employees as Route, 'POST', '/api/payroll/employees', undefined, {
      body: { firstName: 'Sipho', lastName: 'Dlamini', employeeNumber: 'MH-2', employmentType: 'permanent', startDate: '2026-11-01' },
    });
    expect(made.statusCode, JSON.stringify(made.body)).toBe(201);
    const list = await callB(employees as Route, 'GET', '/api/payroll/employees', undefined);
    expect(list.statusCode, JSON.stringify(list.body)).toBe(200);
    const nums = (list.body.data as unknown as Array<{ employeeNumber: string }>).map((e) => e.employeeNumber);
    expect(nums).toContain('MH-2');
    expect(nums).not.toContain('MH-1');
  });
});
