/**
 * Creating a payroll component through the real route (withAuth chain, owner): earnings and deductions are made;
 * an employer contribution is refused with a 400 that says payroll does not process it, and so is any other type.
 * Before, 'employer_contribution' died on payroll_components.component_type VARCHAR(20) (a 500), and the calculator
 * ignores the type anyway (no cost, journal line or EMP201/IRP5 figure), so it is not offered (Hein 2026-10-25).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { SignJWT } from 'jose';
import components from '../../pages/api/payroll/components';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { cleanPayrollCompanies, seedPayrollCompany, type Route } from './w3-01-payroll.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const company = crypto.randomUUID();
const owner = crypto.randomUUID();
let token = '';

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'Component types']);
  await seedPayrollCompany(pool, company);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [owner, `${owner}@test.local`]);
  await pool.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'owner')", [company, owner]);
  token = await new SignJWT({ sub: owner, aal: 'aal2' }).setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
});

afterAll(async () => {
  try {
    await cleanPayrollCompanies(pool, [company]);
    await pool.query('DELETE FROM users WHERE id = $1', [owner]);
  } finally { await pool.end(); }
});

async function post(body: Record<string, unknown>) {
  const req = request({ 'sb-access-token': token, active_company_id: company }, 'POST') as never as { url: string; query: Record<string, unknown>; body: unknown };
  req.url = '/api/payroll/components';
  req.query = {};
  req.body = body;
  const out = response();
  await (components as Route)(req as never, out.res as never);
  return { status: out.state.statusCode, json: JSON.stringify(out.state.body ?? '') };
}
const names = async () => (await pool.query<{ name: string; component_type: string }>(
  'SELECT name, component_type FROM payroll_components WHERE company_id = $1 ORDER BY name', [company])).rows;

describe('POST /api/payroll/components: component types', () => {
  it('an earning and a deduction are created', async () => {
    for (const [name, componentType, code] of [['CT Basic', 'earning', '3601'], ['CT Union', 'deduction', '4472']] as const) {
      const out = await post({ name, sarsSourceCode: code, componentType });
      expect(out.status, out.json).toBe(201);
    }
    expect((await names()).filter((r) => r.name.startsWith('CT '))).toEqual([
      { name: 'CT Basic', component_type: 'earning' }, { name: 'CT Union', component_type: 'deduction' },
    ]);
  });

  it('an employer contribution is refused (400, saying why) and nothing is written', async () => {
    const before = await names();
    const out = await post({ name: 'CT Employer pension', sarsSourceCode: '4474', componentType: 'employer_contribution' });
    expect(out.status, out.json).toBe(400);
    expect(out.json).toMatch(/employer contributions are not supported/i);
    expect(await names()).toEqual(before);
  });

  it('any other type is refused (400), not a database error', async () => {
    const before = await names();
    for (const componentType of ['employer_benefit', 'Earning', 7]) {
      const out = await post({ name: `CT ${String(componentType)}`, sarsSourceCode: '3601', componentType });
      expect(out.status, out.json).toBe(400);
      expect(out.json).toMatch(/componentType must be 'earning' or 'deduction'/);
    }
    expect(await names()).toEqual(before);
  });
});
